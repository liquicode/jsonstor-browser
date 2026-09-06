'use strict';


const jsongin = require( '@liquicode/jsongin' );


//---------------------------------------------------------------------
// ***One record per document, and the record is not the document.***
//
// This is the only one of the three browser storages which is not a blob, and
// `jsonstor-leveldb` is its nearest relative in the family: a per-document store with no query
// language, where the whole of the design is how a document is keyed and how a collection is
// enumerated. What IndexedDB adds is that it hosts the index itself, which no adapter without a
// server has been able to say before.
//
// A record is:
//
//     { Seq: <auto>, Key: '<encoded identifier>', Complex: 1, Document: { ... } }
//
// ***`Seq` is the store's key and it is not the identifier.*** Keying the store on the
// identifier would have been the obvious design and it spends the natural order: IndexedDB
// iterates in key order, so a collection would read back sorted by its identifier rather than
// in the order it was written, which every other adapter in this family promises. An
// auto-incrementing key ascends with insertion, so a cursor walks the collection in the order
// the documents arrived. `jsonstor-leveldb` made the same trade for the same reason.
//
// ***`Key` is the encoded identifier and it carries a unique index.*** That is where
// `IndexHostedBy: 'database'` comes from - the constraint and the lookup are IndexedDB's rather
// than this adapter's, so `RefreshIndex()` has nothing to rebuild.
//
//   ***It is encoded rather than raw, and that is not decoration.*** IndexedDB refuses three of
//   the value types a jsonstor identifier may hold - measured in Chrome 152, a boolean, a null
//   and an object are each a `DataError` - and, worse, an ***index*** over an invalid key value
//   does not fail, it ***silently skips the record***. So a raw index over the identifier would
//   have stopped enforcing uniqueness for exactly the identifiers it could not represent, and
//   would have reported success while doing it. The encoded form is a string for every value,
//   which is the same answer `jsonstor-couchdb` reached when CouchDB refused a numeric `_id`.
//
// ***`Complex` marks a record whose identifier is not a scalar***, and it is absent otherwise.
// IndexedDB does not index a record which has no value at the index's key path, so counting
// that index is a cheap way to ask whether the collection holds one - which is what decides
// whether a by-key lookup can be trusted at all. See `find_by_index`.


const STORE_KEY_PATH = 'Seq';
const KEY_INDEX = 'by_key';
const COMPLEX_INDEX = 'by_complex';


//---------------------------------------------------------------------
// An IndexedDB request as a promise.
//
// ***Everything in this file goes through these two.*** The API is event-based and the family
// is async/await throughout, and a half-translated adapter is where transaction lifetimes get
// lost.
function request_promise( Request )
{
	return new Promise( function ( Resolve, Reject )
	{
		Request.onsuccess = function () { Resolve( Request.result ); };
		Request.onerror = function () { Reject( Request.error ); };
	} );
}


//---------------------------------------------------------------------
// ***A write is not done when its request succeeds, it is done when its transaction
// commits.*** Resolving on the request would let a caller read back a document the browser has
// not yet written, which is a plausible answer rather than a failure - the shape this family
// keeps meeting.
function transaction_promise( Transaction )
{
	return new Promise( function ( Resolve, Reject )
	{
		Transaction.oncomplete = function () { Resolve( true ); };
		Transaction.onerror = function () { Reject( Transaction.error ); };
		Transaction.onabort = function () { Reject( Transaction.error || new Error( 'The transaction was aborted.' ) ); };
	} );
}


module.exports = {

	AdapterName: 'jsonstor-browser-indexeddb',
	AdapterDescription: 'Documents are stored in a browser IndexedDB database.',

	GetAdapter: function ( jsonstor, Settings )
	{


		//=====================================================================
		/*
			Settings = {
				DatabaseName: '',    // The IndexedDB database. Created if it does not exist.
				CollectionName: '',  // The object store documents of this storage are kept in.
			}
		*/
		if ( jsongin.ShortType( Settings ) !== 'o' ) { throw new Error( `This adapter requires a Settings parameter.` ); }
		if ( jsongin.ShortType( Settings.DatabaseName ) !== 's' ) { throw new Error( `This adapter requires a Settings.DatabaseName string parameter.` ); }
		if ( !Settings.DatabaseName.length ) { throw new Error( `Settings.DatabaseName cannot be empty.` ); }
		if ( jsongin.ShortType( Settings.CollectionName ) !== 's' ) { throw new Error( `This adapter requires a Settings.CollectionName string parameter.` ); }
		if ( !Settings.CollectionName.length ) { throw new Error( `Settings.CollectionName cannot be empty.` ); }

		// ***This adapter exists only in a browser, and it says so before it does anything.***
		// Refusing by name is the rule `jsonstor-leveldb` applies to a composite key: an adapter
		// which cannot honor what it was asked for names the part it cannot honor, rather than
		// failing later inside a call which looks like it is about documents.
		if ( typeof indexedDB === 'undefined' )
		{
			throw new Error( `[${module.exports.AdapterName}] requires a browser and there is no IndexedDB here.` );
		}


		//=====================================================================
		let Storage = jsonstor.StorageInterface();
		Storage.Settings = jsongin.Clone( Settings );


		//=====================================================================
		// The key, resolved.
		let key_declaration = jsonstor.PrimaryKey.Resolve( Storage.Settings );
		if ( key_declaration.Fields.length > 1 )
		{
			// ***Declared, not built.*** One index entry holds one encoded value, so an adapter
			// which cannot honor a composite key refuses it by name.
			throw new Error( `[${module.exports.AdapterName}] does not support a composite PrimaryKey: [${key_declaration.Fields.join( ', ' )}].` );
		}
		if ( key_declaration.Fields.length === 0 ) { key_declaration.Fields = [ jsonstor.PrimaryKey.DEFAULT_FIELD ]; }

		Storage.PrimaryKeyInfo = {
			Fields: key_declaration.Fields,
			// The store's own key is the sequence, not the identifier, so there is no key
			// column whose type would need declaring. The index entry carries the encoded value
			// and the document carries the true one.
			Types: [],
			Mutable: key_declaration.Mutable,
			Generated: true,
			// ***The first browser storage which can say this.*** The unique index over the
			// encoded identifier is IndexedDB's own: it enforces the constraint and it answers
			// the lookup, so nothing here maintains an index and RefreshIndex has nothing to
			// rebuild.
			IndexHostedBy: 'database',
		};


		//=====================================================================
		// What the two stages did, for a storage which has no first stage.
		//
		// ***This adapter pushes no criteria down, and that is the measurement.*** IndexedDB has
		// no query language, so every criteria is the residual entire and jsongin decides every
		// row. Reporting it makes this comparable with an adapter which does push down.
		function report_scan( Options, Criteria, Scanned, Matched )
		{
			jsonstor.ReportStatistics( Options, {
				Translator: '',
				Pushdown: null,
				PushdownRows: Scanned,
				Residual: ( jsongin.ShortType( Criteria ) === 'o' ) ? Criteria : {},
				ResidualRows: Matched,
			} );
			return;
		}


		//=====================================================================
		// What the index did.
		//
		// ***An index is a pushdown for an adapter with no server to push down to***, so it
		// reports in the same pair of numbers a WHERE clause does. PushdownRows is one or zero
		// rather than the size of the collection, and that difference is the whole assertion.
		function report_lookup( Options, Criteria, Scanned, Matched )
		{
			jsonstor.ReportStatistics( Options, {
				Translator: '',
				Pushdown: Criteria,
				PushdownRows: Scanned,
				Residual: {},
				ResidualRows: Matched,
			} );
			return;
		}


		//=====================================================================
		// The database, opened once and shared.
		//=====================================================================


		let opening = null;


		//---------------------------------------------------------------------
		// ***An object store can only be created inside a version change***, which is the one
		// piece of this adapter with no analogue anywhere else in the family. A database which
		// has never seen this collection has to be closed and reopened a version higher, with
		// the store created on the way through.
		//
		// ***So the open is two opens in the worst case and one in the ordinary one.*** A
		// storage constructed against a collection which already exists never reaches the
		// second.
		// ***A held connection blocks somebody else's version change, so every connection this
		// adapter opens agrees to step aside.***
		//
		// IndexedDB will not run a version change while another connection to that database is
		// open: it fires `blocked` and waits. So two storages on one database - which is the
		// ordinary case, because a database holds many collections - ***deadlock*** the moment
		// the second one names a collection which does not exist yet. The first storage's
		// connection is open, the second's upgrade waits for it forever, and neither call ever
		// returns. Measured: the probe page hung for its full two minutes and reported nothing.
		//
		// `versionchange` is IndexedDB's own answer to this. The connection closes itself and
		// the memo is forgotten, so the next call to this storage opens a fresh connection to
		// the upgraded database - and the storage that was waiting proceeds.
		function step_aside_on_version_change( Database )
		{
			Database.onversionchange = function ()
			{
				Database.close();
				opening = null;
			};
			return Database;
		}


		async function open_database()
		{
			let db = await request_promise( indexedDB.open( Storage.Settings.DatabaseName ) );
			if ( db.objectStoreNames.contains( Storage.Settings.CollectionName ) )
			{
				return step_aside_on_version_change( db );
			}

			let next_version = db.version + 1;
			db.close();

			let request = indexedDB.open( Storage.Settings.DatabaseName, next_version );
			request.onupgradeneeded = function ( Event )
			{
				let upgrading = Event.target.result;
				// ***Checked again inside the upgrade.*** Two storages naming the same new
				// collection can both reach here, and the second one's upgrade runs against a
				// database the first has already changed.
				if ( upgrading.objectStoreNames.contains( Storage.Settings.CollectionName ) ) { return; }
				let store = upgrading.createObjectStore( Storage.Settings.CollectionName,
					{ keyPath: STORE_KEY_PATH, autoIncrement: true } );
				// ***Unique, so IndexedDB refuses a duplicate identifier rather than this
				// adapter noticing one.***
				store.createIndex( KEY_INDEX, 'Key', { unique: true } );
				store.createIndex( COMPLEX_INDEX, 'Complex', { unique: false } );
				return;
			};
			// ***A block which nobody steps aside from is reported rather than waited on.***
			// Every connection this adapter opens closes itself above, so a block reaching here
			// means something else on this origin is holding the database - another tab, or a
			// page which opened it directly. Saying so is worth a great deal more than waiting,
			// because an IndexedDB open which is blocked never fails and never returns: it looks
			// exactly like a hang, which is how this was found.
			let opened = await new Promise( function ( Resolve, Reject )
			{
				request.onsuccess = function () { Resolve( request.result ); };
				request.onerror = function () { Reject( request.error ); };
				request.onblocked = function ()
				{
					Reject( new Error( `[${module.exports.AdapterName}] cannot create the collection `
						+ `[${Storage.Settings.CollectionName}] because another connection to `
						+ `[${Storage.Settings.DatabaseName}] is open and did not close. `
						+ `Another tab or another page is holding it.` ) );
				};
			} );
			return step_aside_on_version_change( opened );
		}


		//---------------------------------------------------------------------
		async function held_database()
		{
			if ( opening === null )
			{
				opening = open_database().catch( function ( OpenError )
				{
					// ***A failed open is forgotten***, so a storage pointed at a database which
					// cannot be opened fails every time it is asked rather than once. A
					// remembered failure would answer an empty collection for the life of the
					// page, which is the defect `004) Unreachable Storage Tests` exists to catch.
					opening = null;
					throw OpenError;
				} );
			}
			return await opening;
		}


		//---------------------------------------------------------------------
		async function object_store( Mode )
		{
			let db = await held_database();
			let transaction = db.transaction( Storage.Settings.CollectionName, Mode );
			return { Transaction: transaction, Store: transaction.objectStore( Storage.Settings.CollectionName ) };
		}


		//=====================================================================
		// Records
		//=====================================================================


		//---------------------------------------------------------------------
		// ***The document, as JSON would have stored it.***
		//
		// IndexedDB uses the structured clone algorithm, which is more faithful than JSON: a
		// `Date` comes back a `Date` rather than an ISO string, and a member explicitly set to
		// `undefined` survives the write. Both were measured in Chrome 152.
		//
		// ***Both are kept out, deliberately.*** Every other storage in this family round-trips
		// its documents through JSON, so an adapter which preserved more would answer differently
		// from the row beside it in the conformance report - and the whole purpose of that row is
		// that a difference between it and its neighbours means something. A `Date` where every
		// sibling gives a string is a portability trap rather than a feature.
		function as_json( Document )
		{
			return JSON.parse( JSON.stringify( Document ) );
		}


		//---------------------------------------------------------------------
		// The record holding this document, without a sequence - IndexedDB assigns that.
		function record_for( Document )
		{
			let record = { Document: as_json( Document ) };
			let value = jsonstor.PrimaryKey.DocumentValue( Document, Storage.PrimaryKeyInfo.Fields );
			if ( value !== null )
			{
				record.Key = jsonstor.PrimaryKey.EncodeValue( value );
				// ***Absent rather than false for a scalar.*** IndexedDB does not index a record
				// which has no value at the index's key path, so leaving the member off is what
				// keeps the complex index holding only the records it is asked about.
				if ( !jsonstor.PrimaryKey.IsScalar( value ) ) { record.Complex = 1; }
			}
			return record;
		}


		//---------------------------------------------------------------------
		// The encoded identifier a document carries, or null when it carries none.
		function document_key_of( Document )
		{
			return jsonstor.PrimaryKey.DocumentKey( Document, Storage.PrimaryKeyInfo.Fields );
		}


		//---------------------------------------------------------------------
		// Mints an identifier for a document which arrived without one.
		//
		// ***Here this is not an optimization, it is what keeps the write legal.*** IndexedDB
		// answers `DataError` for a record with no value at an indexed key path when that index
		// is unique - and every document in this family gets an identifier anyway.
		function apply_new_key( Document )
		{
			let field = Storage.PrimaryKeyInfo.Fields[ 0 ];
			let value = jsongin.GetValue( Document, field );
			if ( typeof value !== 'undefined' ) { return; }
			jsongin.SetValue( Document, field, jsonstor.NewUniqueID() );
			return;
		}


		//---------------------------------------------------------------------
		// Refuses an update or a replace which moved the identifier. See
		// jsonx/.plans/primary-keys-and-indexes.md - refusing is the only one of the three
		// measured behaviors which cannot mislead a caller.
		function check_key_move( Before, After )
		{
			if ( Storage.PrimaryKeyInfo.Mutable ) { return; }
			if ( Before === After ) { return; }
			throw new Error( `The primary key [${Storage.PrimaryKeyInfo.Fields[ 0 ]}] is not mutable, and this operation would change it from [${Before}] to [${After}].` );
		}


		//---------------------------------------------------------------------
		// Refuses an identifier which is already in the collection.
		//
		// ***One index read rather than a scan***, which is the whole reason the index is here.
		// The unique index would refuse the write anyway, with a `ConstraintError` naming
		// nothing a caller can act on - so this asks first and reports what the rest of the
		// family reports.
		async function require_unique( EncodedKey, ExceptSequence )
		{
			if ( EncodedKey === null ) { return; }
			let opened = await object_store( 'readonly' );
			let found = await request_promise( opened.Store.index( KEY_INDEX ).get( EncodedKey ) );
			if ( typeof found === 'undefined' ) { return; }
			if ( found && ( found[ STORE_KEY_PATH ] === ExceptSequence ) ) { return; }
			throw new Error( `A document with this primary key already exists: ${EncodedKey}.` );
		}


		//---------------------------------------------------------------------
		// Every record in the collection, in natural order.
		//
		// ***`getAll` answers in key order, and the key is the sequence***, so this is the order
		// the documents were inserted in.
		async function read_records()
		{
			let opened = await object_store( 'readonly' );
			let records = await request_promise( opened.Store.getAll() );
			return records;
		}


		//---------------------------------------------------------------------
		// ***How many documents this collection holds, without reading one.***
		async function count_records()
		{
			let opened = await object_store( 'readonly' );
			return await request_promise( opened.Store.count() );
		}


		//---------------------------------------------------------------------
		// ***The record a by-key criteria asks for, or null to ask the scan.***
		//
		// One index read and no cursor. A miss is only trustworthy while every identifier in the
		// collection is a scalar, which is what the complex index records: jsongin matches
		// `{ _id: 'x' }` against a document whose identifier is `[ 'x' ]`, by the array element
		// rule every operator obeys, so an index filed under the array cannot answer that
		// criteria and the collection must be scanned instead.
		//
		// ***The complex count is read before the index and not after a miss.*** A hit is just as
		// wrong as a miss once the collection holds a non-scalar identifier - the criteria
		// matches both documents - so answering with the hit alone would lose a row and report
		// success. `jsonstor-leveldb` learned this with the two-document case it exists for.
		async function find_by_index( Criteria )
		{
			let encoded = jsonstor.PrimaryKey.CriteriaKey( Criteria, Storage.PrimaryKeyInfo.Fields );
			if ( encoded === null ) { return null; }

			let complex = await object_store( 'readonly' );
			let complex_count = await request_promise( complex.Store.index( COMPLEX_INDEX ).count() );
			if ( complex_count > 0 ) { return null; }

			let opened = await object_store( 'readonly' );
			let record = await request_promise( opened.Store.index( KEY_INDEX ).get( encoded ) );
			if ( typeof record === 'undefined' ) { return { Records: [] }; }
			return { Records: [ record ] };
		}


		//---------------------------------------------------------------------
		// Applies a list of { Put } and { Delete } in one transaction.
		//
		// ***One transaction rather than one per document.*** The same shape as the round trip
		// per statement which cost this family a measured 34ms against 3.8ms in
		// `jsonstor-mssql` - cheaper here, and no reason to buy the lesson twice.
		async function write_records( Operations )
		{
			if ( !Operations.length ) { return; }
			let opened = await object_store( 'readwrite' );
			for ( let index = 0; index < Operations.length; index++ )
			{
				let operation = Operations[ index ];
				if ( operation.Delete !== undefined ) { opened.Store.delete( operation.Delete ); }
				else { opened.Store.put( operation.Put ); }
			}
			// ***Awaited on the transaction, not on the last request.*** See transaction_promise.
			await transaction_promise( opened.Transaction );
			return;
		}


		//---------------------------------------------------------------------
		// null, undefined and {} all mean "every document".
		function criteria_matches_everything( Criteria )
		{
			let short_type = jsongin.ShortType( Criteria );
			if ( 'lu'.includes( short_type ) ) { return true; }
			if ( Object.keys( Criteria ).length === 0 ) { return true; }
			return false;
		}


		//---------------------------------------------------------------------
		// Criteria this storage will accept at all.
		function check_criteria( Criteria )
		{
			let short_type = jsongin.ShortType( Criteria );
			if ( !'olu'.includes( short_type ) ) { throw new Error( `Criteria must be an object, null, or undefined.` ); }
			return;
		}


		//---------------------------------------------------------------------
		// The first record satisfying Criteria. Stops at the match.
		async function find_first( Criteria )
		{
			let matches_everything = criteria_matches_everything( Criteria );
			let records = await read_records();
			for ( let index = 0; index < records.length; index++ )
			{
				if ( matches_everything || jsongin.Query( records[ index ].Document, Criteria ) )
				{
					return records[ index ];
				}
			}
			return null;
		}


		//=====================================================================
		// StorageInfo
		//=====================================================================


		// ***What this storage is actually talking to.*** IndexedDB has no version to ask for -
		// a database's `version` is the schema number this adapter itself advances, not a
		// product version - so this reports the engine which decides every query here, the way
		// `jsonstor-jsonfile` does.
		Storage.StorageInfo = async function ( Options )
		{
			return jsonstor.BuildStorageInfo( Storage, {
				Product: 'jsongin',
				Version: jsongin.Library.version,
				InProcess: true,
			} );
		};


		//=====================================================================
		// DropStorage
		//=====================================================================


		// ***The collection is emptied and the database is not deleted.***
		//
		// A database holds many object stores, so deleting it would take every neighbouring
		// collection with it - the same reason `jsonstor-leveldb` clears a key range rather than
		// removing its folder.
		Storage.DropStorage = async function ( Options )
		{
			let opened = await object_store( 'readwrite' );
			opened.Store.clear();
			await transaction_promise( opened.Transaction );
			return true;
		};


		//=====================================================================
		// RefreshIndex
		//=====================================================================


		// ***The database hosts the index, so there is nothing here to rebuild.***
		//
		// It answers 0 and means it. Every sibling which returns a number returns the entries it
		// filed; this one files none, because IndexedDB maintains the unique index over the
		// encoded identifier itself and cannot be out of step with the records it indexes.
		// See jsonx/.plans/primary-keys-and-indexes.md.
		Storage.RefreshIndex = async function ( Options )
		{
			await held_database();
			return 0;
		};


		//=====================================================================
		// FlushStorage
		//=====================================================================


		// Every write here is already committed - a call does not return until its transaction
		// completes - so there is nothing to force.
		Storage.FlushStorage = async function ( Options )
		{
			await held_database();
			return true;
		};


		//=====================================================================
		// Count
		//=====================================================================


		Storage.Count = async function ( Criteria, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			check_criteria( Criteria );

			// ***An unfiltered count never reads a document.*** Every other adapter's count of
			// everything is a cheap answer from the medium, and IndexedDB's `count()` is this
			// medium's version of one.
			if ( criteria_matches_everything( Criteria ) )
			{
				let counted = await count_records();
				report_scan( Options, Criteria, counted, counted );
				return counted;
			}

			let looked_up = await find_by_index( Criteria );
			let records = looked_up ? looked_up.Records : await read_records();
			let matched = 0;
			for ( let index = 0; index < records.length; index++ )
			{
				if ( jsongin.Query( records[ index ].Document, Criteria ) ) { matched++; }
			}
			if ( looked_up ) { report_lookup( Options, Criteria, records.length, matched ); }
			else { report_scan( Options, Criteria, records.length, matched ); }
			return matched;
		};


		//=====================================================================
		// InsertOne
		//=====================================================================


		Storage.InsertOne = async function ( Document, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			if ( jsongin.ShortType( Document ) !== 'o' ) { throw new Error( `Document must be an object.` ); }
			let document = jsongin.Clone( Document );
			apply_new_key( document );
			await require_unique( document_key_of( document ), null );
			await write_records( [ { Put: record_for( document ) } ] );
			if ( Options.ReturnDocuments ) { return document; }
			return 1;
		};


		//=====================================================================
		// InsertMany
		//=====================================================================


		Storage.InsertMany = async function ( Documents, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			if ( jsongin.ShortType( Documents ) !== 'a' ) { throw new Error( `Documents must be an array of objects.` ); }
			let operations = [];
			let inserted = [];
			let seen = {};
			for ( let index = 0; index < Documents.length; index++ )
			{
				let document = jsongin.Clone( Documents[ index ] );
				apply_new_key( document );
				let encoded = document_key_of( document );
				// ***A duplicate inside the batch is caught here, not by the index.*** The
				// records are not written yet, so IndexedDB cannot see the collision the way it
				// sees one against a document already stored.
				if ( ( encoded !== null ) && seen[ encoded ] )
				{
					throw new Error( `A document with this primary key already exists: ${encoded}.` );
				}
				await require_unique( encoded, null );
				if ( encoded !== null ) { seen[ encoded ] = true; }
				operations.push( { Put: record_for( document ) } );
				inserted.push( document );
			}
			await write_records( operations );
			if ( Options.ReturnDocuments ) { return inserted; }
			return inserted.length;
		};


		//=====================================================================
		// FindOne
		//=====================================================================


		Storage.FindOne = async function ( Criteria, Projection, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			check_criteria( Criteria );
			let looked_up = await find_by_index( Criteria );
			if ( looked_up )
			{
				let matched = null;
				for ( let index = 0; index < looked_up.Records.length; index++ )
				{
					if ( !jsongin.Query( looked_up.Records[ index ].Document, Criteria ) ) { continue; }
					matched = jsongin.Project( looked_up.Records[ index ].Document, Projection );
					break;
				}
				report_lookup( Options, Criteria, looked_up.Records.length, matched ? 1 : 0 );
				return matched;
			}
			let found = await find_first( Criteria );
			let scanned = await count_records();
			let document = null;
			if ( found ) { document = jsongin.Project( found.Document, Projection ); }
			report_scan( Options, Criteria, scanned, document ? 1 : 0 );
			return document;
		};


		//=====================================================================
		// FindMany
		//=====================================================================


		Storage.FindMany = async function ( Criteria, Projection, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			check_criteria( Criteria );
			let looked_up = await find_by_index( Criteria );
			let records = looked_up ? looked_up.Records : await read_records();
			let matches_everything = criteria_matches_everything( Criteria );
			let documents = [];
			for ( let index = 0; index < records.length; index++ )
			{
				let document = records[ index ].Document;
				if ( matches_everything || jsongin.Query( document, Criteria ) )
				{
					documents.push( jsongin.Project( document, Projection ) );
				}
			}
			if ( looked_up ) { report_lookup( Options, Criteria, records.length, documents.length ); }
			else { report_scan( Options, Criteria, records.length, documents.length ); }
			return documents;
		};


		//=====================================================================
		// FindMany2
		//=====================================================================


		Storage.FindMany2 = async function ( Criteria, Projection, Sort, MaxCount, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			check_criteria( Criteria );
			let looked_up = await find_by_index( Criteria );
			let records = looked_up ? looked_up.Records : await read_records();
			let matches_everything = criteria_matches_everything( Criteria );
			let documents = [];
			for ( let index = 0; index < records.length; index++ )
			{
				let document = records[ index ].Document;
				if ( matches_everything || jsongin.Query( document, Criteria ) )
				{
					documents.push( jsongin.Project( document, Projection ) );
				}
			}
			if ( Sort ) { documents = jsongin.Sort( documents, Sort ); }
			if ( MaxCount && ( MaxCount > 0 ) && ( documents.length >= MaxCount ) ) { documents = documents.splice( 0, MaxCount ); }
			if ( looked_up ) { report_lookup( Options, Criteria, records.length, documents.length ); }
			else { report_scan( Options, Criteria, records.length, documents.length ); }
			return documents;
		};


		//=====================================================================
		// UpdateOne
		//=====================================================================


		Storage.UpdateOne = async function ( Criteria, Updates, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			check_criteria( Criteria );
			let found = await find_first( Criteria );
			let modified = null;
			let modified_count = 0;
			if ( found )
			{
				// ***The sequence does not move when a document is updated***, so a document
				// keeps the position in the natural order it was inserted at. Writing it under a
				// fresh sequence would send it to the end of the collection, which no other
				// adapter does and no caller asked for.
				modified = jsongin.Update( found.Document, Updates );
				let before = document_key_of( found.Document );
				let after = document_key_of( modified );
				check_key_move( before, after );
				if ( before !== after ) { await require_unique( after, found[ STORE_KEY_PATH ] ); }
				let record = record_for( modified );
				record[ STORE_KEY_PATH ] = found[ STORE_KEY_PATH ];
				await write_records( [ { Put: record } ] );
				modified_count++;
			}
			if ( Options.ReturnDocuments ) { return modified; }
			return modified_count;
		};


		//=====================================================================
		// UpdateMany
		//=====================================================================


		Storage.UpdateMany = async function ( Criteria, Updates, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			check_criteria( Criteria );
			let records = await read_records();
			let matches_everything = criteria_matches_everything( Criteria );
			let operations = [];
			let modified = [];
			for ( let index = 0; index < records.length; index++ )
			{
				let record = records[ index ];
				if ( !matches_everything && !jsongin.Query( record.Document, Criteria ) ) { continue; }
				let document = jsongin.Update( record.Document, Updates );
				let before = document_key_of( record.Document );
				let after = document_key_of( document );
				check_key_move( before, after );
				if ( before !== after ) { await require_unique( after, record[ STORE_KEY_PATH ] ); }
				let written = record_for( document );
				written[ STORE_KEY_PATH ] = record[ STORE_KEY_PATH ];
				operations.push( { Put: written } );
				modified.push( document );
			}
			await write_records( operations );
			if ( Options.ReturnDocuments ) { return modified; }
			return modified.length;
		};


		//=====================================================================
		// ReplaceOne
		//=====================================================================


		Storage.ReplaceOne = async function ( Criteria, Document, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			if ( jsongin.ShortType( Document ) !== 'o' ) { throw new Error( `Document must be an object.` ); }
			let found = await find_first( Criteria );
			let modified = null;
			let modified_count = 0;
			if ( found )
			{
				modified = jsongin.Clone( Document );
				// ***A replacement with no primary key carries the matched document's key
				// over***, which is the behavior the family settled on after finding three of
				// them across thirteen adapters.
				let key_field = Storage.PrimaryKeyInfo.Fields[ 0 ];
				if ( typeof jsongin.GetValue( modified, key_field ) === 'undefined' )
				{
					let carried = jsongin.GetValue( found.Document, key_field );
					if ( typeof carried !== 'undefined' ) { jsongin.SetValue( modified, key_field, carried ); }
				}
				let before = document_key_of( found.Document );
				let after = document_key_of( modified );
				check_key_move( before, after );
				if ( before !== after ) { await require_unique( after, found[ STORE_KEY_PATH ] ); }
				let record = record_for( modified );
				record[ STORE_KEY_PATH ] = found[ STORE_KEY_PATH ];
				await write_records( [ { Put: record } ] );
				modified_count++;
			}
			if ( Options.ReturnDocuments ) { return modified; }
			return modified_count;
		};


		//=====================================================================
		// DeleteOne
		//=====================================================================


		Storage.DeleteOne = async function ( Criteria, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			check_criteria( Criteria );
			let found = await find_first( Criteria );
			let deleted = null;
			let deleted_count = 0;
			if ( found )
			{
				deleted = found.Document;
				await write_records( [ { Delete: found[ STORE_KEY_PATH ] } ] );
				deleted_count++;
			}
			if ( Options.ReturnDocuments ) { return deleted; }
			return deleted_count;
		};


		//=====================================================================
		// DeleteMany
		//=====================================================================


		Storage.DeleteMany = async function ( Criteria, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			check_criteria( Criteria );
			let records = await read_records();
			let matches_everything = criteria_matches_everything( Criteria );
			let operations = [];
			let deleted = [];
			for ( let index = 0; index < records.length; index++ )
			{
				let record = records[ index ];
				if ( !matches_everything && !jsongin.Query( record.Document, Criteria ) ) { continue; }
				operations.push( { Delete: record[ STORE_KEY_PATH ] } );
				deleted.push( record.Document );
			}
			await write_records( operations );
			if ( Options.ReturnDocuments ) { return deleted; }
			return deleted.length;
		};


		//=====================================================================
		return Storage;
	},

};
