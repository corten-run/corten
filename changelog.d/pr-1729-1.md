- Staged requests share their incoming header reads across cache, security and error handling.
  Handler extractors still see header changes made by middleware or earlier extractors.
