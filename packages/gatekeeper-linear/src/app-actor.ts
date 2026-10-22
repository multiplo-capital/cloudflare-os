import { WorkerEntrypoint } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";

type Env = Cloudflare.Env & { CLIENT_ID?: string; CLIENT_SECRET?: string };

export type AppActorIssue = { id: string; identifier: string; url: string };

export type AppActorComment = { body: string; createdAt: string };

export type AppActorIssueDetail = AppActorIssue & {
  title: string;
  description: string;
  createdAt: string;
  open: boolean;
  comments: AppActorComment[];
};

type IssueNode = {
  id: string;
  identifier: string;
  url: string;
  title: string;
  description: string | null;
  createdAt: string;
  state: { type: string };
  comments: { nodes: AppActorComment[] };
};

const CLOSED_STATE_TYPES = ["completed", "canceled"];
const ISSUE_FIELDS = "id identifier url title description createdAt state { type } comments(first: 10) { nodes { body createdAt } }";
const MAX_LISTED_ISSUES = 500;

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

function detail(node: IssueNode, recentComments: number): AppActorIssueDetail {
  return {
    id: node.id,
    identifier: node.identifier,
    url: node.url,
    title: node.title,
    description: node.description ?? "",
    createdAt: node.createdAt,
    open: !CLOSED_STATE_TYPES.includes(node.state.type),
    comments: node.comments.nodes.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-recentComments),
  };
}

async function teamStates(env: Env, issueId: string): Promise<{ id: string; name: string; type: string; position: number }[]> {
  const data = await graphql<{ issue: { team: { states: { nodes: { id: string; name: string; type: string; position: number }[] } } } }>(
    env,
    "query States($id: String!) { issue(id: $id) { team { states { nodes { id name type position } } } } }",
    { id: issueId },
  );
  return data.issue.team.states.nodes.toSorted((a, b) => a.position - b.position);
}

async function setState(env: Env, issueId: string, stateId: string): Promise<void> {
  await graphql(env, "mutation Update($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }", {
    id: issueId,
    input: { stateId },
  });
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

  async listOpenIssues(input: { teamKey: string; titlePrefix: string; recentComments: number }): Promise<AppActorIssueDetail[]> {
    const issues: AppActorIssueDetail[] = [];
    let after: string | null = null;
    do {
      const data: { issues: { nodes: IssueNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await graphql(
        this.env,
        `query Issues($filter: IssueFilter, $after: String) { issues(filter: $filter, first: 50, after: $after) { nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage endCursor } } }`,
        {
          filter: {
            team: { key: { eq: input.teamKey } },
            title: { startsWith: input.titlePrefix },
            state: { type: { nin: CLOSED_STATE_TYPES } },
          },
          after,
        },
      );
      issues.push(...data.issues.nodes.map((node) => detail(node, input.recentComments)));
      after = data.issues.pageInfo.hasNextPage ? data.issues.pageInfo.endCursor : null;
    } while (after && issues.length < MAX_LISTED_ISSUES);
    return issues;
  }

  async getIssue(id: string, recentComments: number): Promise<AppActorIssueDetail | null> {
    const data = await graphql<{ issue: IssueNode | null }>(this.env, `query Issue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`, { id }).catch(
      (error: unknown) => {
        if (String(error).includes("Entity not found")) return { issue: null };
        throw error;
      },
    );
    return data.issue ? detail(data.issue, recentComments) : null;
  }

  async reopen(id: string): Promise<void> {
    const states = await teamStates(this.env, id);
    const state = ["unstarted", "backlog", "triage"].map((type) => states.find((s) => s.type === type)).find(Boolean);
    if (!state) throw new Error(`Linear has no open state to move ${id} back to.`);
    await setState(this.env, id, state.id);
  }

  async markDuplicate(id: string, duplicateOf: string): Promise<void> {
    await graphql(this.env, "mutation Relate($input: IssueRelationCreateInput!) { issueRelationCreate(input: $input) { success } }", {
      input: { issueId: id, relatedIssueId: duplicateOf, type: "duplicate" },
    });
    const states = await teamStates(this.env, id);
    const state = states.find((s) => s.type === "canceled" && s.name.toLowerCase() === "duplicate") ?? states.find((s) => s.type === "canceled");
    if (state) await setState(this.env, id, state.id);
  }
}
