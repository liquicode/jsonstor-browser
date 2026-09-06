'use strict';

/*
	@liquicode/jsonstor-browser - the browser storages, in one package.

	***Three primes, one package, and no version between them.***

	`localStorage`, the Origin Private File System and IndexedDB are three different storage
	mechanisms in the same runtime, so this package is a family in the sense
	jsonx/.plans/versioned-adapters.md describes - one package housing several adapters, each
	registering under its own name - and every one of them is a ***prime***. None is an alias,
	because none of them behaves like another: a caller choosing between them is choosing a
	quota, a write path and a failure mode, not a version.

	***No prime declares a Version, and that is deliberate.*** Everywhere else in this family a
	prime is a ***floor*** - a version number covering every server from itself upward until the
	next prime - and `jsonstor.CheckDialectBoundary` picks the profile for a measured server by
	sorting a family on that number. These three have no version dimension at all. Giving them
	numbers would put three unrelated storages on one line and hand a caller the profile
	belonging to whichever sorted below the browser's reported version, which is exactly the
	mis-resolution `jsonstor-redis` avoided by declining a second prime and
	`jsonstor-elasticsearch` met from the other side.

	***The boundary check answers nothing here, by construction.*** It counts only primes which
	declare a floor and returns early when none does, so three floorless primes are three
	profiles and no comparison. The version each storage reports is `jsongin`'s - the engine
	which actually decides its queries - and it is informational rather than a floor.

	***Each prime carries its own GetAdapter, which is new for this family.*** Oracle, MySQL and
	Elasticsearch all share one implementation across their primes and differ only in the dialect
	profile handed to a translator. Here the primes are three separate implementations. That is
	what a mechanism family looks like as opposed to a version family, and `LoadPlugin` supports
	it already: it registers each entry's own object.

	***The bare name is not a storage.*** `jsonstor-browser` names the package rather than any one
	of the three, and the three are not interchangeable - a caller who did not choose between them
	has not said what they want. So asking for it refuses by name and lists the three, rather than
	quietly serving whichever one happened to be picked as a default.
	*(User decision, on rolling -localstorage, -opfs and -indexeddb into this package.)*

	***The old names are retired rather than aliased.*** *(User decision, same day.)*
	`jsonstor-localstorage`, `jsonstor-opfs` and `jsonstor-indexeddb` do not resolve here. None of
	the three was ever published to npm, so no installed caller can be holding one, and an alias
	kept only for tidiness is a second name for a thing which already has one.
*/

const LOCALSTORAGE = require( './jsonstor-browser-localstorage.js' );
const OPFS = require( './jsonstor-browser-opfs.js' );
const INDEXEDDB = require( './jsonstor-browser-indexeddb.js' );


module.exports = {

	AdapterName: 'jsonstor-browser',
	AdapterDescription: 'The browser storages: local storage, the Origin Private File System, and IndexedDB.',

	//---------------------------------------------------------------------
	// ***The package name is not one of the storages.***
	//
	// `LoadPlugin` registers the plugin object under its own name whenever the package does not
	// alias that name onto a prime, so `jsonstor-browser` is a name `GetStorage` will accept and
	// this is what it gets. Refusing here rather than leaving the name unregistered is the
	// friendlier half of the same answer: an unknown adapter says only that the name is wrong,
	// and this says which three names are right.
	GetAdapter: function ( jsonstor, Settings )
	{
		throw new Error( `[${module.exports.AdapterName}] names this package rather than a storage. `
			+ `Ask for one of [${LOCALSTORAGE.AdapterName}], [${OPFS.AdapterName}] or `
			+ `[${INDEXEDDB.AdapterName}] - they are three different mechanisms and none of them `
			+ `is a sensible default for the others.` );
	},

	//---------------------------------------------------------------------
	// ***The primes.*** Each is a mechanism rather than a floor, so none declares a Version.
	Adapters: [
		LOCALSTORAGE,
		OPFS,
		INDEXEDDB,
	],

};
