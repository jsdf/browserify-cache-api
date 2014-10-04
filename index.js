var fs = require('fs');
var path = require('path');
var util = require('util');
var assert = require('assert');

var through = require('through2');
var async = require('async');
var assign = require('xtend/mutable');

CONCURRENCY_LIMIT = 20;

module.exports = browserifyCache;
browserifyCache.getCacheObjects = getCacheObjects;
browserifyCache.getModuleCache = getModuleCache;
browserifyCache.getPackageCache = getPackageCache;
browserifyCache.invalidateCache = invalidateCache;
browserifyCache.invalidateModifiedFiles = invalidateModifiedFiles;
browserifyCache.updateMtime = updateMtime;
browserifyCache.args = { cache: {}, packageCache: {}, fullPaths: true };

function browserifyCache(b, opts) {
  guard(b);
  opts = opts || {};

  if (getCacheObjects(b)) return b; // already attached

  var cacheFile = opts.cacheFile || opts.cachefile;

  var co;
  co = loadCacheObjects(b, cacheFile);
  // even when not loading anything, create initial cache structure
  setCacheObjects(b, CacheObjects(co));

  attachCacheObjectHooks(b);
  
  attachCacheObjectDiscoveryHandlers(b);

  attachCacheObjectPersistHandler(b, cacheFile);

  return b;
}

function attachCacheObjectHooks(b) {
  if (isBrowserify5x(b)) { 
    // browserify 5.x
    attachCacheObjectHooksToPipeline(b);
  } else {
    // browserify 3.x/4.x
    attachCacheObjectHooksToBundler(b);
  }
}

// browserify 5.x compatible
function attachCacheObjectHooksToPipeline(b) {
  var co = getCacheObjects(b);

  assert(b._options.fullPaths, "required browserify 'fullPaths' opt not set")
  assert(b._options.cache, "required browserify 'cache' opt not set")
  // b._options.cache is a shared object into which loaded cache data is merged.
  // it will be reused for each build, and mutated when the cache is invalidated
  co.modules = assign(b._options.cache, co.modules);

  var bundle = b.bundle.bind(b);
  b.bundle = function (cb) {
    if (b._pending) return bundle(cb);

    var outputStream = through.obj();

    invalidateCacheBeforeBundling(b, function(err, invalidated) {
      if (err) return outputStream.emit('error', err);

      bundle(cb).pipe(outputStream);
    });
    return outputStream;
  };

  splicePipeline(b);
  b.on('reset', function() {
    splicePipeline(b);
  });
}

function splicePipeline(b) {
  guard(b);
  var depsStream = b._createDeps(b._options);
  depsStream.label = 'deps';
  // replicate event proxying from module deps to browserify instance and pipeline
  proxyEventsFromModuleDepsStream(depsStream, b)
  proxyEventsFromModuleDepsStream(depsStream, b.pipeline)

  b.pipeline.splice('deps', 1, depsStream);
}

// browserify 3.x/4.x compatible
function attachCacheObjectHooksToBundler(b) {
  var bundle = b.bundle.bind(b);
  b.bundle = function (optsOrCb, orCb) {
    if (b._pending) return bundle(optsOrCb, orCb);

    var opts, cb;
    if (typeof optsOrCb === 'function') {
      cb = optsOrCb;
      opts = {};
    } else {
      opts = optsOrCb;
      cb = orCb;
    }
    opts = opts || {};

    var outputStream = through.obj();

    invalidateCacheBeforeBundling(b, function(err, invalidated) {
      if (err) return outputStream.emit('error', err);

      // provide invalidated module cache as module-deps 'cache' opt
      opts.cache = getModuleCache(b);
      // TODO: invalidate packageCache
      opts.packageCache = getPackageCache(b);

      var bundleStream = bundle(opts, cb);
      proxyEvent(bundleStream, outputStream, 'transform');
      bundleStream.pipe(outputStream);
    });
    return outputStream;
  };
}

function invalidateCacheBeforeBundling(b, done) {
  guard(b);
  var co = getCacheObjects(b);

  invalidateCache(co.mtimes, co.modules, function(err, invalidated, deleted) {
    b.emit('changedDeps', invalidated, deleted);
    b.emit('update', invalidated); // deprecated
    done(err, invalidated);
  });
}

function attachCacheObjectDiscoveryHandlers(b) {
  guard(b);

  b.on('dep', function (dep) {
    updateCacheOnDep(b, dep);
  });

  b.on('file', function (file, id, parent) {
    // console.log('got file', file, id)
  });

  b.on('package', function (fileOrPkg, orPkg) {
    // browserify 3.x/4.x args are (file, pkg)
    // browserify 5.x args are (pkg)
    var file, pkg;
    if (!orPkg) {
      pkg = fileOrPkg;
      file = undefined;
    } else {
      file = fileOrPkg;
      pkg = orPkg;
    }
    updateCacheOnPackage(b, file, pkg);
  });
}

function attachCacheObjectPersistHandler(b, cacheFile) {
  guard(b);
  b.on('bundle', function(bundleStream) {
    // store on completion
    bundleStream.on('end', function () {
      storeCacheObjects(b, cacheFile);
    });
  });
}

function updateCacheOnDep(b, dep) {
  var co = getCacheObjects(b);
  var file = dep.file || dep.id;
  if (typeof file === 'string') {
    if (dep.source != null) {
      co.modules[file] = dep;
      if (!co.mtimes[file]) updateMtime(co.mtimes, file);
    } else {
      console.warn('missing source for dep', file)
    }
  } else {
    console.warn('got dep missing file or string id', file);
  }
}

function updateCacheOnPackage(b, file, pkg) {
  if (isBrowserify5x(b)) return;
  var co = getCacheObjects(b);
  var pkgpath = pkg.__dirname;

  if (pkgpath) {
    onPkgpath(pkgpath);
  } else {
    var filedir = path.dirname(file)
    fs.exists(path.join(filedir, 'package.json'), function (exists) {
      if (exists) onPkgpath(filedir);
      // else throw new Error("couldn't resolve package for "+file+" from "+filedir);
    })
  }

  function onPkgpath(pkgpath) {
    guard(pkgpath)
    pkg.__dirname = pkg.__dirname || pkgpath;
    co.packages[pkgpath] || (co.packages[pkgpath] = pkg);
    co.filesPackagePaths[file] || (co.filesPackagePaths[file] = pkgpath);
    b.emit('cacheObjectsPackage', pkgpath, pkg);
  }
}

function proxyEventsFromModuleDepsStream(moduleDepsStream, target) {
  ['transform', 'file', 'missing', 'package'].forEach(function(eventName) {
    proxyEvent(moduleDepsStream, target, eventName);
  });
}

// caching

function CacheObjects(co_) {
  var co;
  // cache storage structure
  co = co_ || {};
  co.modules = co.modules || {}; // module-deps opt 'cache'
  co.packages = co.packages || {};  // module-deps opt 'packageCache'
  co.mtimes = co.mtimes || {}; // maps cached file filepath to mtime when cached
  co.filesPackagePaths = co.filesPackagePaths || {}; // maps file paths to parent package paths
  return co;
}

function getCacheObjects(b) {
  guard(b);
  return b.__cacheObjects;
}

function setCacheObjects(b, cacheObjects) {
  guard(b); guard(cacheObjects);
  b.__cacheObjects = cacheObjects;
}

function getModuleCache(b) {
  guard(b);
  var co = getCacheObjects(b);
  return co.modules;
}

function getPackageCache(b) {
  guard(b);
  var co = getCacheObjects(b);
  // rebuild packageCache from packages
  return Object.keys(co.filesPackagePaths).reduce(function(packageCache, file) {
    packageCache[file] = co.packages[co.filesPackagePaths[file]];
    return packageCache;
  }, {});
}

function storeCacheObjects(b, cacheFile) {
  guard(b);
  if (cacheFile) {
    var co = getCacheObjects(b);
    fs.writeFile(cacheFile, JSON.stringify(co), {encoding: 'utf8'}, function(err) {
      if (err) b.emit('_cacheFileWriteError', err);
      else b.emit('_cacheFileWritten', cacheFile);
    });
  }
}

function loadCacheObjects(b, cacheFile) {
  guard(b);
  var co = {};
  if (cacheFile && !getCacheObjects(b)) {
    try {
      co = JSON.parse(fs.readFileSync(cacheFile, {encoding: 'utf8'}));
    } catch (err) {
      // no existing cache file
      b.emit('_cacheFileReadError', err);
    }
  }
  return co;
}

function updateMtime(mtimes, file) {
  guard(mtimes); guard(file);
  fs.stat(file, function (err, stat) {
    if (!err) mtimes[file] = stat.mtime.getTime();
  });
}

function invalidateCache(mtimes, cache, done) {
  guard(mtimes);
  invalidateModifiedFiles(mtimes, Object.keys(cache), function(file) {
    delete cache[file];
  }, done)
}

function invalidateModifiedFiles(mtimes, files, invalidate, done) {
  var invalidated = [];
  var deleted = [];
  async.eachLimit(files, CONCURRENCY_LIMIT, function(file, fileDone) {
    fs.stat(file, function (err, stat) {
      if (err) {
        deleted.push(file);
        return fileDone();
      }
      var mtimeNew = stat.mtime.getTime();
      if(!(mtimes[file] && mtimeNew && mtimeNew <= mtimes[file])) {
        invalidate(file);
        invalidated.push(file);
      }
      mtimes[file] = mtimeNew;
      fileDone();
    });
  }, function(err) {
    done(null, invalidated, deleted);
  });
}

// util 

function isBrowserify5x(b) {
  guard(b);
  return !!b._createPipeline;
}

function guard(value, name) {
  assert(value, 'missing '+(name || 'argument'));
}

function proxyEvent(source, target, name) {
  source.on(name, function() {
    target.emit.apply(target, [name].concat(arguments));
  });
}
