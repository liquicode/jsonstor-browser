'use strict';


const jsongin = require( '@liquicode/jsongin' );


//---------------------------------------------------------------------
// ***The whole collection lives under one key, as one JSON string.***
//
// `localStorage` is a string-to-string map with no iteration order worth relying on and no
// partial update, so a document per key would buy nothing and cost a read of every key on
// every query. One key holding the serialized collection is what `jsonstor-jsonfile` does with
// one file, and this adapter is that adapter with `setItem` where `writeFileSync` is.
//
// ***The quota is the reason to say this out loud.*** An origin gets about 5MB for everything
// it stores, measured at 4.96MB in Chrome 152, so a caller keeping a large collection here
// will meet `QuotaExceededError` from `setItem` - which this adapter lets through rather than
// swallowing. `jsonstor-opfs` is the browser storage with room.


module.exports = {

	AdapterName: 'jsonstor-browser-localstorage',
	AdapterDescription: 'Documents are cached in memory and persisted to browser local storage.',

	GetAdapter: function ( jsonstor, Settings )
	{


		//=====================================================================
		/*
			Settings = {
				Key: '',          // The localStorage key this collection is stored under.
				AutoFlush: true,  // Flush to localStorage on each insert, update, replace, or delete.
			}
		*/
		if ( jsongin.ShortType( Settings ) !== 'o' ) { throw new Error( `This adapter requires a Settings parameter.` ); }
		if ( jsongin.ShortType( Settings.Key ) !== 's' ) { throw new Error( `This adapter requires a Settings.Key string parameter.` ); }
		if ( !Settings.Key.length ) { throw new Error( `Settings.Key cannot be empty.` ); }
		if ( jsongin.ShortType( Settings.AutoFlush ) !== 'b' ) { Settings.AutoFlush = true; }

		// ***This adapter exists only in a browser, and it says so before it does anything.***
		// Constructed in Node it would fail on the first read with a `localStorage is not
		// defined` reference error, from inside a call which looks like it is about documents.
		// Refusing by name here is the rule `jsonstor-leveldb` applies to a composite key: an
		// adapter which cannot honor what it was asked for says which part it cannot honor.
		if ( typeof localStorage === 'undefined' )
		{
			throw new Error( `[${module.exports.AdapterName}] requires a browser and there is no localStorage here.` );
		}


		//=====================================================================
		// ***The memory adapter is the storage and this one is the persistence.***
		//
		// Every document function forwards to it, exactly as `jsonstor-jsonfile` does, so the
		// query, the projection, the update, the sort and the primary key are one
		// implementation rather than a second copy which could drift from it. What this file
		// adds is where the bytes go.
		let Storage = jsonstor.StorageInterface();
		Storage.Settings = Settings;
		Storage.MemoryStorage = jsonstor.GetStorage( 'jsonstor-memory', Settings );
		// ***The key is the memory storage's, because the memory storage is where it is
		// enforced.*** A second resolution here would be a second description of one fact.
		Storage.PrimaryKeyInfo = Storage.MemoryStorage.PrimaryKeyInfo;

		read_storage();


		//=====================================================================
		// ***Every read rebuilds the index***, because the read replaces the whole store rather
		// than adding to it. An index left over from the previous contents does not return
		// wrong rows, it ***loses them silently***. Synchronous, because `localStorage` is.
		function read_storage()
		{
			Storage.MemoryStorage.Store = [];
			let json = localStorage.getItem( Settings.Key );
			// ***An absent key and an empty collection are the same storage.*** getItem answers
			// null for a key nothing has written, which is what a storage looks like before its
			// first flush, so there is nothing to distinguish and nothing to report.
			if ( json !== null )
			{
				Storage.MemoryStorage.Store = JSON.parse( json );
			}
			Storage.MemoryStorage.RebuildIndex();
			return;
		}


		//=====================================================================
		// ***A `QuotaExceededError` travels.*** An origin gets about 5MB and this adapter
		// cannot make it bigger, so the caller is told which write did not happen rather than
		// being handed a storage which quietly stopped persisting.
		function write_storage()
		{
			let json = JSON.stringify( Storage.MemoryStorage.Store );
			localStorage.setItem( Settings.Key, json );
			return;
		}


		//=====================================================================
		function drop_storage()
		{
			Storage.MemoryStorage.Store = [];
			Storage.MemoryStorage.RebuildIndex();
			localStorage.removeItem( Settings.Key );
			return;
		}


		//=====================================================================
		// ***Flushes what the memory storage says changed.*** The memory adapter raises
		// IsDirty when a call actually altered the store, so a delete which matched nothing
		// costs no write.
		function flush_if_dirty()
		{
			if ( Storage.MemoryStorage.IsDirty )
			{
				if ( Settings.AutoFlush ) { write_storage(); }
				Storage.MemoryStorage.IsDirty = false;
			}
			return;
		}


		//=====================================================================
		// StorageInfo
		//=====================================================================


		// ***What this storage is actually talking to.*** `localStorage` has no version to ask
		// for - it is a browser API rather than a server - so this reports the engine which
		// answers every query here, which is what `jsonstor-jsonfile` reports for the same
		// reason. The medium is named on the topic page, where a version would be a fiction.
		Storage.StorageInfo = async function ( Options )
		{
			return jsonstor.BuildStorageInfo( Storage, {
				Product: 'jsongin',
				Version: jsongin.Library.version,
				InProcess: true,
			} );
		};


		//=====================================================================
		// RefreshIndex
		//=====================================================================


		// ***Re-reads the key and rebuilds the index from what is in it.***
		//
		// ***This adapter caches the whole collection, so a foreign write makes the documents
		// stale and not only the index.*** Another tab writing this same key is the ordinary
		// case here rather than the exotic one - `localStorage` is shared across every tab of
		// an origin - so refreshing an index without re-reading would rebuild an index over
		// contents which are equally out of date, and report success.
		Storage.RefreshIndex = async function ( Options )
		{
			read_storage();
			return await Storage.MemoryStorage.RefreshIndex( Options );
		};


		//=====================================================================
		// DropStorage
		//=====================================================================


		Storage.DropStorage = async function ( Options )
		{
			drop_storage();
			return true;
		};


		//=====================================================================
		// FlushStorage
		//=====================================================================


		Storage.FlushStorage = async function ( Options )
		{
			write_storage();
			return true;
		};


		//=====================================================================
		// Count
		//=====================================================================


		Storage.Count = async function ( Criteria, Options )
		{
			let results = await Storage.MemoryStorage.Count( Criteria, Options );
			return results;
		};


		//=====================================================================
		// InsertOne
		//=====================================================================


		Storage.InsertOne = async function InsertOne( Document, Options )
		{
			let results = await Storage.MemoryStorage.InsertOne( Document, Options );
			flush_if_dirty();
			return results;
		};


		//=====================================================================
		// InsertMany
		//=====================================================================


		Storage.InsertMany = async function InsertMany( Documents, Options )
		{
			let results = await Storage.MemoryStorage.InsertMany( Documents, Options );
			flush_if_dirty();
			return results;
		};


		//=====================================================================
		// FindOne
		//=====================================================================


		Storage.FindOne = async function FindOne( Criteria, Projection, Options )
		{
			let results = await Storage.MemoryStorage.FindOne( Criteria, Projection, Options );
			return results;
		};


		//=====================================================================
		// FindMany
		//=====================================================================


		Storage.FindMany = async function FindMany( Criteria, Projection, Options )
		{
			let results = await Storage.MemoryStorage.FindMany( Criteria, Projection, Options );
			return results;
		};


		//=====================================================================
		// FindMany2
		//=====================================================================


		Storage.FindMany2 = async function FindMany2( Criteria, Projection, Sort, Paging, Options )
		{
			let results = await Storage.MemoryStorage.FindMany2( Criteria, Projection, Sort, Paging, Options );
			return results;
		};


		//=====================================================================
		// UpdateOne
		//=====================================================================


		Storage.UpdateOne = async function UpdateOne( Criteria, Update, Options )
		{
			let results = await Storage.MemoryStorage.UpdateOne( Criteria, Update, Options );
			flush_if_dirty();
			return results;
		};


		//=====================================================================
		// UpdateMany
		//=====================================================================


		Storage.UpdateMany = async function UpdateMany( Criteria, Update, Options )
		{
			let results = await Storage.MemoryStorage.UpdateMany( Criteria, Update, Options );
			flush_if_dirty();
			return results;
		};


		//=====================================================================
		// ReplaceOne
		//=====================================================================


		Storage.ReplaceOne = async function ReplaceOne( Criteria, Document, Options )
		{
			let results = await Storage.MemoryStorage.ReplaceOne( Criteria, Document, Options );
			flush_if_dirty();
			return results;
		};


		//=====================================================================
		// DeleteOne
		//=====================================================================


		Storage.DeleteOne = async function DeleteOne( Criteria, Options )
		{
			let results = await Storage.MemoryStorage.DeleteOne( Criteria, Options );
			flush_if_dirty();
			return results;
		};


		//=====================================================================
		// DeleteMany
		//=====================================================================


		Storage.DeleteMany = async function DeleteMany( Criteria, Options )
		{
			let results = await Storage.MemoryStorage.DeleteMany( Criteria, Options );
			flush_if_dirty();
			return results;
		};


		//=====================================================================
		return Storage;
	},

};
