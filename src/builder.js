'use strict';
var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
var fs_1 = require('fs');
var path = require('path');
var crypto = require('crypto');
var utils = require('./utils');
var gulp_util_1 = require('gulp-util');
var ts = require('./typescript/typescriptServices');
var Vinyl = require('vinyl');
function normalize(path) {
    return path.replace(/\\/g, '/');
}
function createTypeScriptBuilder(config) {
    var compilerOptions = createCompilerOptions(config), host = new LanguageServiceHost(compilerOptions), service = ts.createLanguageService(host, ts.createDocumentRegistry()), lastBuildVersion = Object.create(null), lastDtsHash = Object.create(null), userWantsDeclarations = compilerOptions.declaration, oldErrors = Object.create(null), headUsed = process.memoryUsage().heapUsed;
    // always emit declaraction files
    host.getCompilationSettings().declaration = true;
    if (!host.getCompilationSettings().noLib) {
        var defaultLib = host.getDefaultLibFileName();
        host.addScriptSnapshot(defaultLib, new DefaultLibScriptSnapshot(defaultLib));
    }
    function _log(topic, message) {
        if (config.verbose) {
            gulp_util_1.log(gulp_util_1.colors.cyan(topic), message);
        }
    }
    function printDiagnostic(diag, onError) {
        var lineAndCh = diag.file.getLineAndCharacterOfPosition(diag.start), message;
        if (!config.json) {
            message = utils.strings.format('{0}({1},{2}): {3}', diag.file.fileName, lineAndCh.line + 1, lineAndCh.character + 1, diag.messageText);
        }
        else {
            message = JSON.stringify({
                filename: diag.file.fileName,
                offset: diag.start,
                length: diag.length,
                message: diag.messageText
            });
        }
        onError(message);
    }
    function file(file) {
        host.addScriptSnapshot(file.path, new VinylScriptSnapshot(file));
    }
    function baseFor(snapshot) {
        if (snapshot instanceof VinylScriptSnapshot) {
            return compilerOptions.outDir || snapshot.getBase();
        }
        else {
            return '';
        }
    }
    function build(out, onError) {
        var filenames = host.getScriptFileNames(), newErrors = Object.create(null), checkedThisRound = Object.create(null), filesWithShapeChanges = [], t1 = Date.now();
        function shouldCheck(filename) {
            if (checkedThisRound[filename]) {
                return false;
            }
            else {
                checkedThisRound[filename] = true;
                return true;
            }
        }
        function isExternalModule(sourceFile) {
            return !!sourceFile.externalModuleIndicator;
        }
        function getCommonSourceDirectory() {
            return service.getProgram().getCommonSourceDirectory();
        }
        function getDependencyFileName(filename) {
            var ext = path.extname(filename);
            var outDir = config['outDir'];
            if (outDir) {
                var basename = path.basename(filename, ext);
                var dirname = path.dirname(filename);
                var common = getCommonSourceDirectory();
                if (dirname.substr(0, common.length) === common) {
                    return path.join(path.resolve(outDir), dirname.substr(common.length), basename) + '.dep.json';
                }
            }
            return filename.substr(0, filename.length - ext.length) + '.dep.json';
        }
        for (var i = 0, len = filenames.length; i < len; i++) {
            var filename = filenames[i], version = host.getScriptVersion(filename), snapshot = host.getScriptSnapshot(filename);
            if (lastBuildVersion[filename] === version) {
                // unchanged since the last time
                continue;
            }
            var output = service.getEmitOutput(filename), dtsHash = undefined;
            // emit output has fast as possible
            output.outputFiles.forEach(function (file) {
                if (/\.d\.ts$/.test(file.name)) {
                    dtsHash = crypto.createHash('md5')
                        .update(file.text)
                        .digest('base64');
                    if (!userWantsDeclarations) {
                        // don't leak .d.ts files if users don't want them
                        return;
                    }
                }
                _log('[emit output]', file.name);
                out(new Vinyl({
                    path: file.name,
                    contents: new Buffer(file.text),
                    base: baseFor(snapshot)
                }));
            });
            if (config['emitDependencies'] && /\.ts$/.test(filename) && !/\.d\.ts$/.test(filename)) {
                var dependencies = service.getDependencies(filename);
                if (dependencies) {
                    out(new Vinyl({
                        path: getDependencyFileName(filename),
                        contents: new Buffer(JSON.stringify({
                            filePath: dependencies.fileName,
                            compileTime: dependencies.compileTime,
                            runtime: dependencies.runtime
                        }, null, 4)),
                        base: baseFor(snapshot)
                    }));
                }
            }
            // print and store syntax and semantic errors
            delete oldErrors[filename];
            var diagnostics = utils.collections.lookupOrInsert(newErrors, filename, []);
            diagnostics.push.apply(diagnostics, service.getSyntacticDiagnostics(filename));
            diagnostics.push.apply(diagnostics, service.getSemanticDiagnostics(filename));
            diagnostics.forEach(function (diag) { return printDiagnostic(diag, onError); });
            // dts comparing
            if (dtsHash && lastDtsHash[filename] !== dtsHash) {
                lastDtsHash[filename] = dtsHash;
                if (isExternalModule(service.getSourceFile(filename))) {
                    filesWithShapeChanges.push(filename);
                }
                else {
                    filesWithShapeChanges.unshift(filename);
                }
            }
            lastBuildVersion[filename] = version;
            checkedThisRound[filename] = true;
        }
        if (filesWithShapeChanges.length === 0) {
        }
        else if (!isExternalModule(service.getSourceFile(filesWithShapeChanges[0]))) {
            // at least one internal module changes which means that
            // we have to type check all others
            _log('[shape changes]', 'internal module changed → FULL check required');
            host.getScriptFileNames().forEach(function (filename) {
                if (!shouldCheck(filename)) {
                    return;
                }
                _log('[semantic check*]', filename);
                delete oldErrors[filename];
                var diagnostics = utils.collections.lookupOrInsert(newErrors, filename, []);
                service.getSemanticDiagnostics(filename).forEach(function (diag) {
                    diagnostics.push(diag);
                    printDiagnostic(diag, onError);
                });
            });
        }
        else {
            // reverse dependencies
            _log('[shape changes]', 'external module changed → check REVERSE dependencies');
            var needsSemanticCheck = [];
            filesWithShapeChanges.forEach(function (filename) { return host.collectDependents(filename, needsSemanticCheck); });
            while (needsSemanticCheck.length) {
                var filename = needsSemanticCheck.pop();
                if (!shouldCheck(filename)) {
                    continue;
                }
                _log('[semantic check*]', filename);
                delete oldErrors[filename];
                var diagnostics = utils.collections.lookupOrInsert(newErrors, filename, []), hasSemanticErrors = false;
                service.getSemanticDiagnostics(filename).forEach(function (diag) {
                    diagnostics.push(diag);
                    printDiagnostic(diag, onError);
                    hasSemanticErrors = true;
                });
                if (!hasSemanticErrors) {
                    host.collectDependents(filename, needsSemanticCheck);
                }
            }
        }
        // (4) dump old errors
        utils.collections.forEach(oldErrors, function (entry) {
            entry.value.forEach(function (diag) { return printDiagnostic(diag, onError); });
            newErrors[entry.key] = entry.value;
        });
        oldErrors = newErrors;
        if (config._emitLanguageService) {
            out({
                languageService: service,
                host: host
            });
        }
        if (config.verbose) {
            var headNow = process.memoryUsage().heapUsed, MB = 1024 * 1024;
            gulp_util_1.log('[tsb]', 'time:', gulp_util_1.colors.yellow((Date.now() - t1) + 'ms'), 'mem:', gulp_util_1.colors.cyan(Math.ceil(headNow / MB) + 'MB'), gulp_util_1.colors.bgCyan('Δ' + Math.ceil((headNow - headUsed) / MB)));
            headUsed = headNow;
        }
    }
    return {
        file: file,
        build: build
    };
}
exports.createTypeScriptBuilder = createTypeScriptBuilder;
function createCompilerOptions(config) {
    // language version
    if (!config['target']) {
        config['target'] = 0 /* ES3 */;
    }
    else if (/ES3/i.test(String(config['target']))) {
        config['target'] = 0 /* ES3 */;
    }
    else if (/ES5/i.test(String(config['target']))) {
        config['target'] = 1 /* ES5 */;
    }
    else if (/ES6/i.test(String(config['target']))) {
        config['target'] = 2 /* ES6 */;
    }
    // module generation
    if (/commonjs/i.test(String(config['module']))) {
        config['module'] = 1 /* CommonJS */;
    }
    else if (/amd/i.test(String(config['module']))) {
        config['module'] = 2 /* AMD */;
    }
    return config;
}
var ScriptSnapshot = (function () {
    function ScriptSnapshot(text, mtime) {
        this._text = text;
        this._mtime = mtime;
    }
    ScriptSnapshot.prototype.getVersion = function () {
        return this._mtime.toUTCString();
    };
    ScriptSnapshot.prototype.getText = function (start, end) {
        return this._text.substring(start, end);
    };
    ScriptSnapshot.prototype.getLength = function () {
        return this._text.length;
    };
    ScriptSnapshot.prototype.getChangeRange = function (oldSnapshot) {
        return null;
    };
    return ScriptSnapshot;
})();
var DefaultLibScriptSnapshot = (function (_super) {
    __extends(DefaultLibScriptSnapshot, _super);
    function DefaultLibScriptSnapshot(defaultLib) {
        _super.call(this, fs_1.readFileSync(defaultLib).toString(), fs_1.statSync(defaultLib).mtime);
    }
    return DefaultLibScriptSnapshot;
})(ScriptSnapshot);
var VinylScriptSnapshot = (function (_super) {
    __extends(VinylScriptSnapshot, _super);
    function VinylScriptSnapshot(file) {
        _super.call(this, file.contents.toString(), file.stat.mtime);
        this._base = file.base;
    }
    VinylScriptSnapshot.prototype.getBase = function () {
        return this._base;
    };
    return VinylScriptSnapshot;
})(ScriptSnapshot);
var LanguageServiceHost = (function () {
    function LanguageServiceHost(settings) {
        this._settings = settings;
        this._snapshots = Object.create(null);
        this._defaultLib = normalize(path.join(__dirname, 'typescript', 'lib.d.ts'));
        this._dependencies = new utils.graph.Graph(function (s) { return s; });
        this._dependenciesRecomputeList = [];
    }
    LanguageServiceHost.prototype.log = function (s) {
        // nothing
    };
    LanguageServiceHost.prototype.trace = function (s) {
        // nothing
    };
    LanguageServiceHost.prototype.error = function (s) {
        console.error(s);
    };
    LanguageServiceHost.prototype.getCompilationSettings = function () {
        return this._settings;
    };
    LanguageServiceHost.prototype.getScriptFileNames = function () {
        return Object.keys(this._snapshots);
    };
    LanguageServiceHost.prototype.getScriptVersion = function (filename) {
        filename = normalize(filename);
        return this._snapshots[filename].getVersion();
    };
    LanguageServiceHost.prototype.getScriptSnapshot = function (filename) {
        filename = normalize(filename);
        return this._snapshots[filename];
    };
    LanguageServiceHost.prototype.addScriptSnapshot = function (filename, snapshot) {
        filename = normalize(filename);
        var old = this._snapshots[filename];
        if (!old || old.getVersion() !== snapshot.getVersion()) {
            this._dependenciesRecomputeList.push(filename);
            var node = this._dependencies.lookup(filename);
            if (node) {
                node.outgoing = Object.create(null);
            }
        }
        this._snapshots[filename] = snapshot;
        return old;
    };
    LanguageServiceHost.prototype.getLocalizedDiagnosticMessages = function () {
        return null;
    };
    LanguageServiceHost.prototype.getCancellationToken = function () {
        return { isCancellationRequested: function () { return false; } };
    };
    LanguageServiceHost.prototype.getCurrentDirectory = function () {
        return process.cwd();
    };
    LanguageServiceHost.prototype.getDefaultLibFileName = function () {
        return this._defaultLib;
    };
    // ---- dependency management
    LanguageServiceHost.prototype.collectDependents = function (filename, target) {
        while (this._dependenciesRecomputeList.length) {
            this._processFile(this._dependenciesRecomputeList.pop());
        }
        filename = normalize(filename);
        var node = this._dependencies.lookup(filename);
        if (node) {
            utils.collections.forEach(node.incoming, function (entry) { return target.push(entry.key); });
        }
    };
    LanguageServiceHost.prototype._processFile = function (filename) {
        var _this = this;
        if (filename.match(/.*\.d\.ts$/)) {
            return;
        }
        filename = normalize(filename);
        var snapshot = this.getScriptSnapshot(filename), info = ts.preProcessFile(snapshot.getText(0, snapshot.getLength()), true);
        // (1) ///-references
        info.referencedFiles.forEach(function (ref) {
            var resolvedPath = path.resolve(path.dirname(filename), ref.fileName), normalizedPath = normalize(resolvedPath);
            _this._dependencies.inertEdge(filename, normalizedPath);
        });
        // (2) import-require statements
        info.importedFiles.forEach(function (ref) {
            var stopDirname = normalize(_this.getCurrentDirectory()), dirname = filename, found = false;
            while (!found && dirname.indexOf(stopDirname) === 0) {
                dirname = path.dirname(dirname);
                var resolvedPath = path.resolve(dirname, ref.fileName), normalizedPath = normalize(resolvedPath);
                if (_this.getScriptSnapshot(normalizedPath + '.ts')) {
                    _this._dependencies.inertEdge(filename, normalizedPath + '.ts');
                    found = true;
                }
                else if (_this.getScriptSnapshot(normalizedPath + '.d.ts')) {
                    _this._dependencies.inertEdge(filename, normalizedPath + '.d.ts');
                    found = true;
                }
            }
        });
    };
    return LanguageServiceHost;
})();