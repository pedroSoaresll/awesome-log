// (c) 2018, The Awesome Engineering Company, https://awesomeneg.com

"use strict";

const AbstractLogFormatter = require("../AbstractLogFormatter");

/**
 * The JSON AwesomeLog formatter. This produces log message in JSON form. This
 * will include all of the details in a log entry Object.
 *
 * @extends AbstractLogFormatter
 */
class JSONFormatter extends AbstractLogFormatter {
	/**
	 * Constructor for this formatter. Never called directly, but called by AwesomeLog
	 * when `Log.start()` is called.
	 *
	 * @param {AwesomeLog} parent
	 */
	constructor(parent) {
		super(parent);
	}

	/**
	 * Given the log entry object, format it tou our output string.
	 *
	 * @param  {Object} logentry
	 * @return {*}
	 */
	format(logentry) {
		return JSON.stringify(logentry);
	}
}

module.exports = JSONFormatter;
