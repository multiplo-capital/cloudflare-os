import { WorkerEntrypoint } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { domainName } from "./domain.js";

type CollectionReaderProps = {
  sharingDomain: string;
  collectionId: string;
};

@validateRpc()
export class CollectionReader extends WorkerEntrypoint<Cloudflare.Env, CollectionReaderProps> {
  async read(path: string): Promise<string | null> {
    const { sharingDomain, collectionId } = this.ctx.props;
    if (!sharingDomain || !collectionId) throw new Error("CollectionReader is bound without a collection.");
    const registries = this.ctx.exports.LibraryRegistryDurableObject;
    if (!(await registries.getByName(sharingDomain).isPublic(collectionId))) {
      throw new Error(`Collection ${collectionId} is not a public collection in this deployment.`);
    }
    const collections = this.ctx.exports.ContextCollectionDurableObject;
    const document = await collections.get(collections.idFromName(domainName(sharingDomain, collectionId))).getContextDocument(path);
    return document?.body ?? null;
  }
}
