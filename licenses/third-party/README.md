# Third-Party License Bundles

This directory holds generated license bundles for Docker image distribution.

Run:

```sh
npm run build:third-party-licenses
```

before building release images. The generated `*.txt` files are intentionally not
committed; they are copied into image-specific subdirectories under
`/usr/share/licenses/wdl/third-party/`.
