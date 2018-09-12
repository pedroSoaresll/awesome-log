// (c) 2018, The Awesome Engineering Company, https://awesomeneg.com

"use strict";

const OS = require("os");
const Events = require("events");
const Process = require("process");

const AwesomeUtils = require("AwesomeUtils");

const LogLevel = require("./LogLevel");
const AbstractLogWriter = require("./AbstractLogWriter");
const AbstractLogFormatter = require("./AbstractLogFormatter");

let Worker;
try {
	Worker = require('worker_threads');
}
catch (ex) {
	Worker = null;
}

const $CONFIG = Symbol("config");
const $DEFINED_WRITERS = Symbol("defined_writers");
const $DEFINED_FORMATTERS = Symbol("defined_formatters");
const $BACKLOG = Symbol("backlog");
const $HISTORY = Symbol("history");
const $FUNCTIONS = Symbol("functions");
const $LEVELS = Symbol("levels");
const $WRITERS = Symbol("writers");
const $RUNNING = Symbol("running");
const $SUBPROCESSES = Symbol("subprocesshandler");
const $BASE = Symbol("base");

/**
 * AwesomeLog class: An instance of this class is returned when you `require("AwesomeLog")`.
 *
 * To use AwesomeLog requires you to first initialize and start AwesomeLog,
 * preferably as early in your application as possible.
 *
 * ```
 * const Log = require("AwesomeLog");
 * Log.init();
 * Log.start();
 * ```
 *
 * You may pass an overall optional configuration to the `init()` method, as needed.
 *
 * Every time your `require("AwesomeLog") you get the same instance. Prior to starting
 * AwesomeLog via `Log.start()`, any log message you send are held in the backlog until
 * AwesomeLog is started. Once started the backlog is written and any future log message
 * will be written.
 *
 * @extends Events
 */
class AwesomeLog extends Events {
	/**
	 * Construct a new AwesomeLog instance. This is only ever called once per application.
	 */
	constructor() {
		super();

		const hostname = OS.hostname();
		const domain = hostname.split(".").slice(-2).join(".");
		const servername = hostname.split(".").slice(0,1);
		let bits = 32;
		let arch = OS.arch();
		if (arch==="arm64" || arch==="mipsel" || arch==="ppc64" || arch==="s390x" || arch==="x64") bits = 64;

		this[$BASE] = {
			hostname,
			domain,
			servername,
			pid: process.pid,
			ppid: process.ppid,
			main: process.mainModule.filename,
			arch: OS.arch(),
			platform: OS.platform(),
			bits,
			cpus: OS.cpus().length,
			argv: process.argv.slice(2).join(" "),
			execPath: process.execPath,
			startingDirectory: process.cwd(),
			homedir: OS.homedir(),
			username: OS.userInfo().username,
			version: process.version
		};

		this[$CONFIG] = null;
		this[$DEFINED_WRITERS] = {};
		this[$DEFINED_FORMATTERS] = {};
		this[$BACKLOG] = [];
		this[$HISTORY] = [];
		this[$FUNCTIONS] = {};
		this[$LEVELS] = [];
		this[$WRITERS] = [];
		this[$RUNNING] = false;
		this[$SUBPROCESSES] = new Map();

		initLevels.call(this,"access,error,warn,info,debug");
	}

	/**
	 * Returns the AbstractLogWriter abstract class.
	 */
	get AbstractLogWriter() {
		return AbstractLogWriter;
	}

	get AbstractLogFormatter() {
		return AbstractLogFormatter;
	}

	get initialized() {
		return this[$CONFIG]!==null;
	}

	get running() {
		return this[$RUNNING];
	}

	get config() {
		return AwesomeUtils.Object.extend({},this[$CONFIG]);
	}

	get history() {
		return (this[$HISTORY]||[]).slice();
	}

	get historySizeLimit() {
		return this[$CONFIG].historySizeLimit;
	}

	get levels() {
		return this[$LEVELS];
	}

	get levelNames() {
		return this[$LEVELS].map((level)=>{
			return level.name;
		});
	}

	get definedWriters() {
		return AwesomeUtils.Object.extend(this[$DEFINED_WRITERS]);
	}

	get definedFormatters() {
		return AwesomeUtils.Object.extend(this[$DEFINED_FORMATTERS]);
	}

	defineFormatter(name,konstructor) {
		if (!name) throw new Error("Missing formatter name.");
		name = name.toLowerCase();

		if (!konstructor) throw new Error("Missing formatter constructor");
		if (!AbstractLogFormatter.isPrototypeOf(konstructor)) throw new Error("Invalid formatter constructor. Must inherit from AbstractLogFormatter.");

		if (this[$DEFINED_FORMATTERS][name]) throw new Error("Formatter already defined.");

		this[$DEFINED_FORMATTERS][name] = new konstructor(this);

		this.emit("formatter_added",name);
	}

	defineWriter(name,konstructor) {
		if (!name) throw new Error("Missing writer name.");
		name = name.toLowerCase();

		if (!konstructor) throw new Error("Missing writer constructor");
		if (!AbstractLogWriter.isPrototypeOf(konstructor)) throw new Error("Invalid writer constructor. Must inherit from AbstractLogWriter.");

		if (this[$DEFINED_WRITERS][name]) throw new Error("Writer already defined.");

		this[$DEFINED_WRITERS][name] = konstructor;

		this.emit("writer_added",name);
	}

	init(config) {
		if (this.initialized && this.running) throw new Error("Cannot initialize while running. stop() first.");

		let disableSP = config && config.disableSubProcesses || false;
		this[$CONFIG] = AwesomeUtils.Object.extend({
			history: true,
			historySizeLimit: 100,
			historyFormatter: "default",
			levels: "access,error,warn,info,debug",
			disableLoggingNotices: !disableSP && isSubProcess() ? true : false,
			loggingNoticesLevel: "info",
			writers: [],
			backlogSizeLimit: 1000,
			disableSubProcesses: false
		},config||{});
		disableSP = this[$CONFIG].disableSubProcesses;
		if (this[$CONFIG].writers.length<1) this[$CONFIG].writers.push({
			name: "console",
			type:  !disableSP && isSubProcess() ? "subprocess" : "default",
			levels: "*",
			formatter: !disableSP && isSubProcess() ? "subprocess" : "default",
			options: {}
		});

		initLevels.call(this,this.config.levels);
		if (!this.getLevel(this.config.loggingNoticesLevel)) this[$CONFIG].loggingNoticesLevel = this.levels.slice(-1)[0] && this.levels.slice(-1)[0].name || null;

		this[$CONFIG].historyFormatter = this[$DEFINED_FORMATTERS][this[$CONFIG].historyFormatter.toLowerCase()];
		if (!this[$CONFIG].historyFormatter) throw new Error("Invalid history formatter.");

		if (!this.config.disableLoggingNotices) this.log(this.config.loggingNoticesLevel,"AwesomeLog","AwesomeLog initialized.");
		this.emit("initialized",config);

		return this;
	}

	start() {
		if (this.running) return;

		if (this[$CONFIG]===null) this.init();

		this[$RUNNING] = true;
		this[$HISTORY] = [];

		initWriters.call(this);

		[...this[$SUBPROCESSES].keys()].forEach((subprocess)=>{
			this[$SUBPROCESSES].delete(subprocess);
			this.captureSubProcess(subprocess);
		});

		if (this[$BACKLOG]) {
			this[$BACKLOG].forEach((logentry)=>{
				write.call(this,logentry);
			});
		}
		this[$BACKLOG] = null;

		if (!this.config.disableLoggingNotices) this.log(this.config.loggingNoticesLevel,"AwesomeLog","AwesomeLog started.");
		this.emit("started");

		return this;
	}

	stop() {
		if (!this.running) return;
		this[$BACKLOG] = this[$BACKLOG] || [];
		this[$RUNNING] = false;

		[...this[$SUBPROCESSES].keys()].forEach((subprocess)=>{
			this.releaseSubProcess(subprocess);
			this[$SUBPROCESSES].set(subprocess,null);
		});

		this[$WRITERS].forEach((writer)=>{
			writer.flush();
			writer.close();
		});

		if (!this.config.disableLoggingNotices) this.log(this.config.loggingNoticesLevel,"AwesomeLog","AwesomeLog stopped.");
		this.emit("stopped");

		return this;
	}

	pause() {
		if (!this.running) return;
		this[$BACKLOG] = this[$BACKLOG] || [];

		if (!this.config.disableLoggingNotices) this.log(this.config.loggingNoticesLevel,"AwesomeLog","AwesomeLog paused.");
		this.emit("paused");

		return this;
	}

	resume() {
		if (!this.running) return;

		if (this[$BACKLOG]) {
			this[$BACKLOG].forEach((logentry)=>{
				write.call(this,logentry);
			});
		}
		this[$BACKLOG] = null;

		if (!this.config.disableLoggingNotices) this.log(this.config.loggingNoticesLevel,"AwesomeLog","AwesomeLog resumed.");
		this.emit("resumed");

		return this;
	}

	clearHistory() {
		this[$HISTORY] = [];

		return this;
	}

	getLevel(level) {
		if (!level) throw new Error("Missing level argument.");
		if (level instanceof LogLevel) return level;
		if (typeof level==="string") {
			level = level.toUpperCase();
			let index = this[$LEVELS].reduce((index,x,i)=>{
				if (index>-1) return index;
				if (x && x.name && x.name===level) return i;
				return -1;
			},-1);
			return index>-1 && this[$LEVELS][index] || null;
		}
		throw new Error("Invalid level argument.");
	}

	log(level,system,message,...args) {
		let logentry = null;

		if (!system && level && typeof level==="object" && !(level instanceof LogLevel) && level.level && level.system && level.message && level.args) {
			logentry = level;
			system = logentry.system;
			message = logentry.message;
			args = logentry.args;
			level = logentry.level;
		}

		level = this.getLevel(level);
		if (!level) throw new Error("Missing level argument.");
		if (!(level instanceof LogLevel)) throw new Error("Invalid level argument.");
		if (logentry) logentry.level = level;

		if (!system) {
			system = AwesomeUtils.Module.source(1).split(/\\\\|\\|\//g).slice(-1)[0];
		}
		if (typeof system!=="string") throw new Error("Invalid system argument.");
		system = system.replace(/[^\w\d_\-.]/g,""); // strip out any non-alpha characters. _ - and . are also allowed.
		if (logentry) logentry.system = system;

		args = [].concat(args); // has to come before message check
		if (logentry) logentry.args = args;

		if (!message) throw new Error("Missing message argument.");
		if (message instanceof Error) {
			args.unshift(message);
			message = message.message;
		}
		if (typeof message!=="string") throw new Error("Invalid message argument.");

		logentry = Object.assign(this[$BASE],{
			level,
			system,
			message,
			args,
			timestamp: Date.now()
		},logentry||{});

		if (this[$BACKLOG]) {
			this[$BACKLOG].push(logentry);
			if (this[$BACKLOG].length>this.config.backlogSizeLimit) this[$BACKLOG] = this[$BACKLOG].slice(Math.floor(this.backlogSizeLimit*0.1));
		}
		else write.call(this,logentry);

		this.emit("log",logentry);

		return this;
	}

	captureSubProcess(subprocess) {
		if (!subprocess) return;
		if (!subprocess.on) return;
		if (this[$SUBPROCESSES].has(subprocess)) return;

		this[$SUBPROCESSES].set(subprocess,subProcessHandler.bind(this));
		subprocess.on("message",this[$SUBPROCESSES].get(subprocess));

		return this;
	}

	releaseSubProcess(subprocess) {
		if (!subprocess) return;
		if (!subprocess.off) return;
		if (!this[$SUBPROCESSES].has(subprocess)) return;

		subprocess.off("message",this[$SUBPROCESSES].get(subprocess));
		this[$SUBPROCESSES].delete(subprocess);

		return this;
	}
}

const isSubProcess = function isSubProcess() {
	return !!Process.channel || Worker && Worker.parentPort && Worker.parentPort.postMessage || false;
};

const initLevels = function initLevels(levels) {
	// If we have pre-existing levels, remove the functions...
	this[$LEVELS].forEach((level)=>{
		delete this[level.name.toLowerCase()];
		delete this[level.name.toUpperCase()];
		delete this[level.name.slice(0,1).toUpperCase()+level.name.slice(1).toLowerCase()];
	});

	this[$LEVELS] = [];

	let configlevels = levels;
	if (!configlevels) throw new Error("No levels configured.");
	if (typeof configlevels==="string") configlevels = configlevels.split(",");
	if (!(configlevels instanceof Array)) throw new Error("Invalid levels configured.");

	// build our levels array.
	configlevels = AwesomeUtils.Array.compact(configlevels.map((level)=>{
		if (!level) return null;
		if (level instanceof LogLevel) return level;
		if (typeof level==="string") return new LogLevel(level);
	}));
	// make sure not reserved.
	configlevels.forEach((level)=>{
		if (this[level.name.toLowerCase()] || this[level.name.toUpperCase()] ||
		this[level.name.slice(0,1).toUpperCase()+level.name.slice(1).toLowerCase()]) throw new Error("Invalid log level: '"+level.name+"' is a reserved word.");
	});

	this[$LEVELS] = configlevels;

	// add our level functions
	this[$LEVELS].forEach((level)=>{
		let lf = this.log.bind(this,level);

		this[level.name.toLowerCase()] = lf;
		this[level.name.toUpperCase()] = lf;
		this[level.name.slice(0,1).toUpperCase()+level.name.slice(1).toLowerCase()] = lf;
	});
};

const initWriters = function initWriters() {
	// clean up old writers.
	this[$WRITERS].forEach((writer)=>{
		writer.flush();
		writer.close();
	});
	this[$WRITERS] = [];

	let configwriters = this.config.writers;
	if (!configwriters) throw new Error("No writers configured.");
	if (!(configwriters instanceof Array)) throw new Error("Invalid writers configured.");

	// start new writers.
	this[$WRITERS] = AwesomeUtils.Array.compact(configwriters.map((writer)=>{
		if (!writer) return null;

		let name = writer.name || null;
		if (!name) throw new Error("Missing writer name.");
		name = name.replace(/[^\w\d_]/g,""); // strip out any non variables friendly characters.

		let type = writer.type || null;
		if (!type) throw new Error("Missing writer type.");
		type = type.toLowerCase();

		let levels = writer.levels || "*";
		if (!levels) throw new Error("Missing writer levels.");
		levels = levels.toLowerCase();

		let formatter = writer.formatter || "default";
		if (typeof formatter==="string") formatter = this[$DEFINED_FORMATTERS][formatter.toLowerCase()];
		if (!formatter) throw new Error("Missing writer formatter '"+writer.formatter+"'.");
		if (!(formatter instanceof AbstractLogFormatter)) throw new Error("Invalid writer formatter '"+writer.formatter+"', must be of type AbstractLogFormatter.");

		let options = writer.options || {};

		let konstructor = this[$DEFINED_WRITERS][type] || null;
		if (!konstructor) throw new Error("Invalid writer type '"+type+"' does not exist.");

		let instance = new konstructor(this,name,levels,formatter,options);
		return instance;
	}));
};

const write = function write(logentry) {
	if (!logentry) throw new Error("Missing log entry argument.");
	if (!logentry.level || !logentry.system || !logentry.message || !logentry.args || !logentry.timestamp) throw new Error("Invalid log entry argument.");

	if (this.config.history) {
		this[$HISTORY].push(this.config.historyFormatter.format(logentry));
		if (this.history.length> this.config.historySizeLimit) this[$HISTORY] = this[$HISTORY].slice(-this.config.historySizeLimit);
	}

	this[$WRITERS].forEach((writer)=>{
		if (!writer.takesLevel(logentry.level)) return;
		writer.write(writer.format(logentry),logentry); // message,logentry
	});
};

const subProcessHandler = function subProcessHandler(message) {
	if (!message) return;
	if (!message.cmd) return;
	if (!message.cmd==="AwesomeLog") return;

	let logentry = message.logentry;
	this.getLevel(logentry.level); // cuases an exception of the process used a level we dont know.

	this.log(logentry);
};

// create our singleton instance
let instance = new AwesomeLog();

// define built in writers
instance.defineWriter("null",require("./writers/NullWriter"));
instance.defineWriter("nullwriter",require("./writers/NullWriter"));
instance.defineWriter("subprocess",require("./writers/SubProcessWriter"));
instance.defineWriter("default",require("./writers/ConsoleWriter"));
instance.defineWriter("console",require("./writers/ConsoleWriter"));
instance.defineWriter("consolewriter",require("./writers/ConsoleWriter"));
instance.defineWriter("stdout",require("./writers/ConsoleWriter"));
instance.defineWriter("file",require("./writers/FileWriter"));
instance.defineWriter("filewriter",require("./writers/FileWriter"));

// define built in formatters
instance.defineFormatter("default",require("./formatters/DefaultFormatter"));
instance.defineFormatter("subprocess",require("./formatters/SubProcessFormatter"));
instance.defineFormatter("json",require("./formatters/JSONFormatter"));
instance.defineFormatter("js",require("./formatters/JSObjectFormatter"));
instance.defineFormatter("jsobject",require("./formatters/JSObjectFormatter"));
instance.defineFormatter("csv",require("./formatters/CSVFormatter"));

// export the instance.
module.exports = instance;