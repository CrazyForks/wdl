export const MAX_ID_BYTES = 512;
export const CLASS_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
export const METHOD_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
export const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
export const WORKER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/;
// ns field accepts the same shape gateway does (tenant grammar OR reserved
// __<name>__ form). Without this, DO bindings deployed to reserved ns like
// __system__ fail at every host_invoke / actor_create.
export const NS_FIELD_RE = /^(?:[a-z0-9-]+|__[a-z0-9_-]+__)$/;
export const STORAGE_ID_RE = /^[a-z0-9_-]+$/;
export const VERSION_RE = /^v[0-9]+$/;
export const HOST_ID_RE = /^[a-z0-9_-]+:[A-Za-z_$][A-Za-z0-9_$]*:shard[0-9]+$/;
export const DO_HOST_SHARD_COUNT = 16;
