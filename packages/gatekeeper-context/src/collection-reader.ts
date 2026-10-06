import { WorkerEntrypoint } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { listPublicCollectionsFromKv } from "./collection-kv.js";
import { domainName } from "./domain.js";

type CollectionReaderProps = {
  sharingDomain: string;
};

export type PublicSkill = {
  collectionId: string;
  collectionTitle: string;
  path: string;
  skillName: string;
  description: string;
};

@validateRpc()
export class CollectionReader extends WorkerEntrypoint<Cloudflare.Env, CollectionReaderProps> {
  #domain(): string {
    const { sharingDomain } = this.ctx.props;
    if (!sharingDomain) throw new Error("CollectionReader is bound without a sharing domain.");
    return sharingDomain;
  }

  #collection(collectionId: string) {
    const collections = this.ctx.exports.ContextCollectionDurableObject;
    return collections.get(collections.idFromName(domainName(this.#domain(), collectionId)));
  }

  async listSkills(): Promise<PublicSkill[]> {
    const collections = await listPublicCollectionsFromKv(this.env, this.#domain());
    const perCollection = await Promise.all(
      collections.map(async (collection) =>
        (await this.#collection(collection.id).listAgentSkills()).map((skill) => ({
          collectionId: collection.id,
          collectionTitle: collection.title,
          path: skill.path,
          skillName: skill.skillName,
          description: skill.description,
        })),
      ),
    );
    return perCollection.flat();
  }

  async read(collectionId: string, path: string): Promise<string | null> {
    const registries = this.ctx.exports.LibraryRegistryDurableObject;
    if (!(await registries.getByName(this.#domain()).isPublic(collectionId))) {
      throw new Error(`Collection ${collectionId} is not a public collection in this deployment.`);
    }
    const document = await this.#collection(collectionId).getContextDocument(path);
    return document?.body ?? null;
  }
}
