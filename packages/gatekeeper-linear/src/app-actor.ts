import { WorkerEntrypoint } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";

type Env = Cloudflare.Env & { CLIENT_ID?: string; CLIENT_SECRET?: string };

export type AppActorIssue = { id: string; identifier: string; url: string };

const API_BASE = "https://api.linear.app";
const APP_TOKEN_SCOPES = "read,write";

const tokens = new Map<string, Promise<string>>();
const teams = new Map<string, string>();

async function mintToken(clientId: string, clientSecret: string): Promise<string> {
  const response = await fetch(`${API_BASE}/oauth/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials", scope: APP_TOKEN_SCOPES }).toString(),
  });
  const body = (await response.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
  if (!response.ok || !body.access_token) {
    throw new Error(
      `Linear refused an app token: ${response.status} ${body.error_description ?? body.error ?? "no token"}. Turn on client credentials tokens for the OAuth app.`,
    );
  }
  return body.access_token;
}

async function graphql<T>(env: Env, query: string, variables: Record<string, unknown>, retried = false): Promise<T> {
  if (!env.CLIENT_ID || !env.CLIENT_SECRET) throw new Error("The Linear OAuth client is not configured on this gatekeeper.");
  const { CLIENT_ID: clientId, CLIENT_SECRET: clientSecret } = env;
  if (!tokens.has(clientId)) {
    tokens.set(
      clientId,
      mintToken(clientId, clientSecret).catch((error) => {
        tokens.delete(clientId);
        throw error;
      }),
    );
  }
  const response = await fetch(`${API_BASE}/graphql`, {
    method: "POST",
    headers: { authorization: `Bearer ${await tokens.get(clientId)}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (response.status === 401 && !retried) {
    tokens.delete(clientId);
    return graphql(env, query, variables, true);
  }
  const body = (await response.json().catch(() => ({}))) as { data?: T; errors?: { message: string }[] };
  if (!response.ok || body.errors?.length || !body.data) {
    throw new Error(`Linear ${response.status}: ${body.errors?.map((e) => e.message).join("; ") ?? "request failed"}`);
  }
  return body.data;
}

async function teamId(env: Env, key: string): Promise<string> {
  const cached = teams.get(key);
  if (cached) return cached;
  const data = await graphql<{ teams: { nodes: { id: string }[] } }>(
    env,
    "query Teams($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id } } }",
    { key },
  );
  const team = data.teams.nodes[0];
  if (!team) throw new Error(`Linear has no team with key ${key}.`);
  teams.set(key, team.id);
  return team.id;
}

@validateRpc()
export class LinearAppActor extends WorkerEntrypoint<Env> {
  async createIssue(input: { teamKey: string; title: string; description: string }): Promise<AppActorIssue> {
    const data = await graphql<{ issueCreate: { success: boolean; issue: AppActorIssue | null } }>(
      this.env,
      "mutation Create($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }",
      { input: { teamId: await teamId(this.env, input.teamKey), title: input.title.slice(0, 250), description: input.description } },
    );
    if (!data.issueCreate.success || !data.issueCreate.issue) throw new Error("Linear did not create the issue.");
    return data.issueCreate.issue;
  }

  async updateDescription(id: string, description: string): Promise<void> {
    await graphql(this.env, "mutation Update($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }", {
      id,
      input: { description },
    });
  }

  async comment(issueId: string, body: string): Promise<void> {
    await graphql(this.env, "mutation Comment($input: CommentCreateInput!) { commentCreate(input: $input) { success } }", {
      input: { issueId, body },
    });
  }
}
