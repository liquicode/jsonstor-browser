'use strict';


const jsongin = require( '@liquicode/jsongin' );


//---------------------------------------------------------------------
// ***The whole collection lives in one file, as one JSON string.***
//
// This is `jsonstor-localstorage` with a file where the key is, and `jsonstor-jsonfile` with the
// Origin Private File System where `fs` is. All three cache the collection in a memory storage
// and persist it whole, and the differences between them should be visible as the write and
// nothing else.
//
// ***What OPFS buys over localStorage is room.*** An origin's `localStorage` holds about 5MB;
// OPFS reported about ten gigabytes on the same origin in Chrome 152. That is the reason to
// choose this adapter, and it is the only reason - a collection which fits in `localStorage`
// gets a synchronous adapter over there instead of the awaits below.
//
// ***And what it costs is that nothing here is synchronous.*** `createSyncAccessHandle` - the
// fast path OPFS is known for - is Worker-only, and it answered false on the main thread where
// a page runs, so there is no synchronous read to do in `GetAdapter` the way its two siblings
// do. Hence `ensure_loaded()`, which is the shape `jsonstor-couchdb` already uses for a check it
// cannot make while being constructed.


//---------------------------------------------------------------------
// ***A path is walked, so a collection can live in a folder.*** OPFS has real directories -
// measured, along with everything else here - and a caller storing several collections should
// be able to put them somewhere rather than scattering names across the root.
//
// Every segment but the last is a directory, created on the way when the caller is writing.
async function resolve_file( Path, Create )
{
	let segments = Path.split( '/' ).filter( function ( One ) { return ( One.length > 0 ); } );
	let name = segments.pop();
	let folder = await navigator.storage.getDirectory();
	for ( let index = 0; index < segments.length; index++ )
	{
		folder = await folder.getDirectoryHandle( segments[ index ], { create: Create } );
	}
	return { Folder: folder, Name: name };
}


module.exports = {

	AdapterName: 'jsonstor-browser-opfs',
	AdapterDescription: 'Documents are cached in memory and persisted to a file in the browser Origin Private File System.',

	GetAdapter: function ( jsonstor, Settings )
	{


		//=====================================================================
		/*
			Settings = {
				Path: '',         // The OPFS file this collection is stored in. Folders are created.
				AutoFlush: true,  // Flush to the file on each insert, update, replace, or delete.
			}
		*/
		if ( jsongin.ShortType( Settings ) !== 'o' ) { throw new Error( `This adapter requires a Settings parameter.` ); }
		if ( jsongin.ShortType( Settings.Path ) !== 's' ) { throw new Error( `This adapter requires a Settings.Path string parameter.` ); }
		if ( !Settings.Path.length ) { throw new Error( `Settings.Path cannot be empty.` ); }
		// ***A path which is all separators names no file.*** Caught here rather than at the
		// first write, where `pop()` would answer undefined and `getFileHandle` would report
		// something about a name rather than about the setting which produced it.
		if ( !Settings.Path.split( '/' ).filter( function ( One ) { return ( One.length > 0 ); } ).length )
		{
			throw new Error( `Settings.Path must name a file.` );
		}
		if ( jsongin.ShortType( Settings.AutoFlush ) !== 'b' ) { Settings.AutoFlush = true; }

		// ***This adapter exists only in a browser, and it says so before it does anything.***
		// Constructed in Node it would fail on the first read inside a call which looks like it
		// is about documents. Refusing by name is the rule `jsonstor-leveldb` applies to a
		// composite key: an adapter which cannot honor what it was asked for says which part.
		if ( typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.getDirectory )
		{
			throw new Error( `[${module.exports.AdapterName}] requires a browser with the Origin Private File System.` );
		}


		//=====================================================================
		// ***The memory adapter is the storage and this one is the persistence.***
		let Storage = jsonstor.StorageInterface();
		Storage.Settings = Settings;
		Storage.MemoryStorage = jsonstor.GetStorage( 'jsonstor-memory', Settings );
		// ***The key is the memory storage's, because the memory storage is where it is
		// enforced.*** A second resolution here would be a second description of one fact.
		Storage.PrimaryKeyInfo = Storage.MemoryStorage.PrimaryKeyInfo;

		// ***The load is a memoized promise rather than a flag.*** Two calls arriving before
		// the first read finishes must both wait for that read, not start a second one - and a
		// flag set on the way in would let the second call proceed against an empty store, which
		// is a plausible answer rather than a failure. Same shape as the held connection in
		// `jsonstor-mysql` and the open store in `jsonstor-leveldb`.
		let loading = null;

		// ***Writes are serialized.*** A caller which does not await two inserts would otherwise
		// have two `createWritable` handles open on one file, and the file would hold whichever
		// closed last rather than the result of both. Chaining them costs nothing when calls are
		// awaited, which is the ordinary case.
		let writing = Promise.resolve();


		//=====================================================================
		// ***Every read rebuilds the index***, because the read replaces the whole store rather
		// than adding to it. An index left over from the previous contents does not return wrong
		// rows, it ***loses them silently***.
		async function read_storage()
		{
			Storage.MemoryStorage.Store = [];
			let json = null;
			try
			{
				// ***Not created here.*** A read which created the file would make a storage
				// pointed at a mistyped path look empty rather than absent, and would leave an
				// empty file behind for every such mistake.
				let located = await resolve_file( Settings.Path, false );
				let handle = await located.Folder.getFileHandle( located.Name, { create: false } );
				let file = await handle.getFile();
				json = await file.text();
			}
			catch ( error )
			{
				// ***An absent file and an empty collection are the same storage***, which is
				// what a storage looks like before its first flush. Anything else is a real
				// failure and travels: a caller whose OPFS is unreadable must not be handed an
				// empty collection which looks like a fresh one.
				if ( error.name !== 'NotFoundError' ) { throw error; }
			}
			// ***An empty file is not an empty collection.*** `JSON.parse( '' )` throws, and a
			// zero-length file is what a half-finished write leaves behind.
			if ( ( json !== null ) && ( json.length > 0 ) )
			{
				Storage.MemoryStorage.Store = JSON.parse( json );
			}
			Storage.MemoryStorage.RebuildIndex();
			return;
		}


		//=====================================================================
		// ***The first call reads the file; every call after it waits on that same read.***
		async function ensure_loaded()
		{
			if ( loading === null ) { loading = read_storage(); }
			try { await loading; }
			catch ( error )
			{
				// ***A failed load is forgotten***, so a storage pointed at something which
				// cannot be read fails every time it is asked rather than once. This is the
				// defect `004) Unreachable Storage Tests` exists to catch, in a medium which
				// has no server to be unreachable.
				loading = null;
				throw error;
			}
			return;
		}


		//=====================================================================
		async function write_storage()
		{
			let json = JSON.stringify( Storage.MemoryStorage.Store );
			writing = writing.then( async function ()
			{
				let located = await resolve_file( Settings.Path, true );
				let handle = await located.Folder.getFileHandle( located.Name, { create: true } );
				// ***`createWritable` truncates.*** The whole collection is written every time,
				// so a shorter collection must not leave the tail of a longer one behind it.
				let writable = await handle.createWritable();
				await writable.write( json );
				await writable.close();
				return;
			} );
			await writing;
			return;
		}


		//=====================================================================
		async function drop_storage()
		{
			Storage.MemoryStorage.Store = [];
			Storage.MemoryStorage.RebuildIndex();
			// ***The walk is inside the guard, not only the removal.*** A `Path` naming folders
			// is resolved without creating them, so on an OPFS which has never been written
			// `getDirectoryHandle` raises `NotFoundError` before `removeEntry` is ever reached -
			// and dropping a storage which does not exist yet is the ordinary first call of
			// every suite here, not an error. Guarding only the removal left 36 of the 148
			// conformance tests failing on a `before` hook.
			try
			{
				let located = await resolve_file( Settings.Path, false );
				await located.Folder.removeEntry( located.Name );
			}
			catch ( error )
			{
				if ( error.name !== 'NotFoundError' ) { throw error; }
			}
			return;
		}


		//=====================================================================
		// ***Flushes what the memory storage says changed.*** The memory adapter raises
		// IsDirty when a call actually altered the store, so a delete which matched nothing
		// costs no write.
		async function flush_if_dirty()
		{
			if ( Storage.MemoryStorage.IsDirty )
			{
				if ( Settings.AutoFlush ) { await write_storage(); }
				Storage.MemoryStorage.IsDirty = false;
			}
			return;
		}


		//=====================================================================
		// StorageInfo
		//=====================================================================


		// ***What this storage is actually talking to.*** OPFS has no version to ask for - it
		// is a browser API rather than a server - so this reports the engine which answers
		// every query here, which is what `jsonstor-jsonfile` reports for the same reason.
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


		// ***Re-reads the file and rebuilds the index from what is in it.***
		//
		// ***This adapter caches the whole collection, so a foreign write makes the documents
		// stale and not only the index.*** Every tab of an origin shares one OPFS, so
		// refreshing an index without re-reading would rebuild an index over contents which are
		// equally out of date, and report success.
		Storage.RefreshIndex = async function ( Options )
		{
			loading = read_storage();
			await loading;
			return await Storage.MemoryStorage.RefreshIndex( Options );
		};


		//=====================================================================
		// DropStorage
		//=====================================================================


		Storage.DropStorage = async function ( Options )
		{
			await ensure_loaded();
			await drop_storage();
			return true;
		};


		//=====================================================================
		// FlushStorage
		//=====================================================================


		Storage.FlushStorage = async function ( Options )
		{
			await ensure_loaded();
			await write_storage();
			return true;
		};


		//=====================================================================
		// Count
		//=====================================================================


		Storage.Count = async function ( Criteria, Options )
		{
			await ensure_loaded();
			let results = await Storage.MemoryStorage.Count( Criteria, Options );
			return results;
		};


		//=====================================================================
		// InsertOne
		//=====================================================================


		Storage.InsertOne = async function InsertOne( Document, Options )
		{
			await ensure_loaded();
			let results = await Storage.MemoryStorage.InsertOne( Document, Options );
			await flush_if_dirty();
			return results;
		};


		//=====================================================================
		// InsertMany
		//=====================================================================


		Storage.InsertMany = async function InsertMany( Documents, Options )
		{
			await ensure_loaded();
			let results = await Storage.MemoryStorage.InsertMany( Documents, Options );
			await flush_if_dirty();
			return results;
		};


		//=====================================================================
		// FindOne
		//=====================================================================


		Storage.FindOne = async function FindOne( Criteria, Projection, Options )
		{
			await ensure_loaded();
			let results = await Storage.MemoryStorage.FindOne( Criteria, Projection, Options );
			return results;
		};


		//=====================================================================
		// FindMany
		//=====================================================================


		Storage.FindMany = async function FindMany( Criteria, Projection, Options )
		{
			await ensure_loaded();
			let results = await Storage.MemoryStorage.FindMany( Criteria, Projection, Options );
			return results;
		};


		//=====================================================================
		// FindMany2
		//=====================================================================


		Storage.FindMany2 = async function FindMany2( Criteria, Projection, Sort, Paging, Options )
		{
			await ensure_loaded();
			let results = await Storage.MemoryStorage.FindMany2( Criteria, Projection, Sort, Paging, Options );
			return results;
		};


		//=====================================================================
		// UpdateOne
		//=====================================================================


		Storage.UpdateOne = async function UpdateOne( Criteria, Update, Options )
		{
			await ensure_loaded();
			let results = await Storage.MemoryStorage.UpdateOne( Criteria, Update, Options );
			await flush_if_dirty();
			return results;
		};


		//=====================================================================
		// UpdateMany
		//=====================================================================


		Storage.UpdateMany = async function UpdateMany( Criteria, Update, Options )
		{
			await ensure_loaded();
			let results = await Storage.MemoryStorage.UpdateMany( Criteria, Update, Options );
			await flush_if_dirty();
			return results;
		};


		//=====================================================================
		// ReplaceOne
		//=====================================================================


		Storage.ReplaceOne = async function ReplaceOne( Criteria, Document, Options )
		{
			await ensure_loaded();
			let results = await Storage.MemoryStorage.ReplaceOne( Criteria, Document, Options );
			await flush_if_dirty();
			return results;
		};


		//=====================================================================
		// DeleteOne
		//=====================================================================


		Storage.DeleteOne = async function DeleteOne( Criteria, Options )
		{
			await ensure_loaded();
			let results = await Storage.MemoryStorage.DeleteOne( Criteria, Options );
			await flush_if_dirty();
			return results;
		};


		//=====================================================================
		// DeleteMany
		//=====================================================================


		Storage.DeleteMany = async function DeleteMany( Criteria, Options )
		{
			await ensure_loaded();
			let results = await Storage.MemoryStorage.DeleteMany( Criteria, Options );
			await flush_if_dirty();
			return results;
		};


		//=====================================================================
		return Storage;
	},

};
