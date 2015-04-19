function Cache(cacheData) {
  var cache = cacheData || {};

  cache.modules = cache.modules || {}; // module-deps opt 'cache'
  cache.packages = cache.packages || {};  // module-deps opt 'packageCache'
  cache.mtimes = cache.mtimes || {}; // maps cached file filepath to mtime when cached
  cache.filesPackagePaths = cache.filesPackagePaths || {}; // maps file paths to parent package paths
  cache.dependentFiles = cache.dependentFiles || {};

  return cache;
}

module.exports = Cache;
