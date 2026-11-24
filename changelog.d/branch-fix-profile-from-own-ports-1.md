- `corten build --profile-from` profiles an app that binds a port of its own and never reads
  `PORT`: with `PORT` set, the copy is looked for on that port in place of a free one, as in
  `PORT=8443 corten build --profile-from sh train.sh`. A `PORT` that is no port number, or one
  something already listens on, is now refused.
  ([deploying](https://github.com/corten-run/corten/blob/main/docs/guide/deploy.md#a-profile-guided-build))
