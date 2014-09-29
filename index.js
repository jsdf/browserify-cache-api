var fs = require('fs');
var path = require('path');
var util = require('util');
var assert = require('assert');

var through = require('through2');
var async = require('async');

module.exports = browserifyCache;
browserifyCache.getCacheObjects = getCacheObjects;
browserifyCache.getModuleCache = getModuleCache;
browserifyCache.getPackageCache = getPackageCache;
browserifyCache.invalidateCache = invalidateCache;
browserifyCache.invalidateModifiedFiles = invalidateModifiedFiles;
browserifyCache.updateMtime = updateMtime;

function browserifyCache(b, opts) {
  guard(b);
  opts = opts || {};

  if (getCacheObjects(b)) return b; // already attached

  var cacheFile = opts.cacheFile || opts.cachefile;

  loadCacheObjects(b, cacheFile);

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
  console.log('attachCacheObjectHooksToPipeline')
  
  function splicePipeline() {
    // this stream will hold our items until we're ready to pipe it to moduleDepsStream
    var inputBufferStream = through.obj(logStream('inputBufferStream'));
    // this stream will accept items from pipeline but we don't want it to produce 
    // any output because it is piped to the wrong stream(!) as an unfortunate 
    // result of the stream splicer pipeline's implicit piping
    // instead we fork its output into the inputBufferStream
    var inputSinkStream = through.obj(function(item, enc, next) {
      inputBufferStream.write(item);
      next();
    }, function(done) {
      // remove self from pipeline before ending
      // b.pipeline.splice('deps-input-sink', 1);
      inputBufferStream.end();
      // done()
    });
    inputSinkStream.label = 'deps-input-sink'

    var cachedDepsStream = getDepsStreamWithCaching(b, b._options, b._createDeps.bind(b));
    // replicate event proxying from module deps to browserify instance and pipeline
    proxyEventsFromModuleDepsStream(cachedDepsStream, b)
    proxyEventsFromModuleDepsStream(cachedDepsStream, b.pipeline)

    // hook up input when module deps is ready (provided with invalidated cache)
    cachedDepsStream.on('moduleDeps', function(moduleDepsStream) {
      inputBufferStream.pipe(moduleDepsStream);
    });

    var removed = b.pipeline.splice('deps', 1, depsStream);
    if (removed) removed.forEach(function(s) { console.log('removed:', s.label) });
    console.log('pipeline:', b.pipeline._streams.map(function(s){ return s.label }))
  }

  splicePipeline()
  b.on('reset', splicePipeline)
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
    invalidateCacheThen(b, function(err) {
      if (err) return outputStream.emit('error', err);

      // provide invalidated module cache as module-deps 'cache' opt
      opts.cache = getModuleCache(b);
      // TODO: invalidate packageCache
      opts.packageCache = getPackageCache(b);

      var bundleStream = bundle(opts, cb);
      proxyEvent('transform', bundleStream, outputStream);
      bundleStream.pipe(outputStream);
    });
    return outputStream;
  };
}

function invalidateCacheThen(b, done) {
  guard(b);
  var co = getCacheObjects(b);

  invalidateCache(co.mtimes, co.modules, function(err, invalidated) {
    b.emit('update', invalidated);
    done(err)
  });
}

function getDepsStreamWithCaching(b, depsOpts, mdeps) {
  guard(b); guard(mdeps);

  var co = getCacheObjects(b);

  var cachedDepsStream;
  var moduleDepsStream;

  cachedDepsStream = through.obj(logStream('cachedDepsStream'));
  cachedDepsStream.label = 'cached-deps';

  invalidateCache(co.mtimes, co.modules, function(err, invalidated) {
    b.emit('update', invalidated);

    // provide invalidated cache as module-deps 'cache' opt
    depsOpts.cache = getModuleCache(b);
    // TODO: invalidate packageCache
    depsOpts.packageCache = getPackageCache(b);

    moduleDepsStream = mdeps(depsOpts);
    proxyEventsFromModuleDepsStream(moduleDepsStream, cachedDepsStream);
    
    moduleDepsStream.pipe(cachedDepsStream);
    cachedDepsStream.emit('moduleDeps', moduleDepsStream);
  });

  return cachedDepsStream;
}

function attachCacheObjectDiscoveryHandlers(b) {
  guard(b);

  b.on('dep', function (dep) {
    updateCacheOnDep(b, dep);
  });

  b.on('file', function (file, id, parent) {
    console.log('got file', file, id)
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
  if (typeof dep.id === 'string') {
    if (dep.source) {
      co.modules[dep.id] = dep;
      if (!co.mtimes[dep.id]) updateMtime(co.mtimes, dep.id);
    } else {
      console.warn('missing source for dep', dep.id)
    }
  } else {
    console.warn('got dep with non string id', dep.id);
  }
}

function updateCacheOnPackage(b, file, pkg) {
  var co = getCacheObjects(b);
  // console.log('updateCacheOnPackage', file, pkg)
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
  if (!Object.keys(co.modules).length) {
    return co.modules;
  }
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
  var co;  
  if (cacheFile && !getCacheObjects(b)) {
    try {
      co = JSON.parse(fs.readFileSync(cacheFile, {encoding: 'utf8'}));
    } catch (err) {
      // no existing cache file
      b.emit('_cacheFileReadError', err);
    }
  }
  // even when not loading anything, create initial cache structure
  setCacheObjects(b, CacheObjects(co));
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
  async.reduce(files, [], function(invalidated, file, fileDone) {
    fs.stat(file, function (err, stat) {
      if (err) return fileDone();
      var mtimeNew = stat.mtime.getTime();
      if(!(mtimes[file] && mtimeNew && mtimeNew <= mtimes[file])) {
        invalidate(file);
        invalidated.push(file);
      }
      mtimes[file] = mtimeNew;
      fileDone(null, invalidated);
    });
  }, function(err, invalidated) {
    done(null, invalidated);
  });
}

// util

function guard(value, name) {
  assert(value, 'missing '+(name || 'argument'));
}

function proxyEvent(source, target, name) {
  source.on(name, function() {
    target.emit.apply(target, [name].concat(arguments));
  });
}

function isBrowserify5x(b) {
  guard(b);
  return !!b._createPipeline;
}


function logStream(name) {
  return function(obj, enc, next) {
    console.log(name,'got object',Object.keys(obj))
    next(null, obj)
  }
}