import { createTaskIdentityResolver } from "shared-task-identity";
import { D1ProtocolError } from "d1-runtime-protocol";

const resolver = createTaskIdentityResolver({
  envPrefix: "D1",
  defaultPort: 8787,
  defaultContainerName: "d1-runtime",
  serviceLabel: "D1",
  unavailableCode: "task-identity-unavailable",
  createError: (status, code, message) => new D1ProtocolError(status, code, message),
});

export const {
  peekTaskIdentity,
  resetTaskIdentityForTests,
  resolveTaskIdentity,
  taskIdentityFromEcsMetadata,
  taskIdentityFromEnv,
} = resolver;
