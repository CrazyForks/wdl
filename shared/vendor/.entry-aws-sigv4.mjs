// Entry for `npm run build:vendor` — esbuild bundles this into
// shared/vendor/aws-sigv4.js, embedded in workerd capnp.
export { SigV4Client, signAwsRequest } from "@wdl-dev/aws-sigv4";
