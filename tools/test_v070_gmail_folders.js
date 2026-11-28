'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const gmailPolicy = require('../engine/lib/mail_gmail_policy');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const backend = read('engine/backend.js'), imapSource = read('engine/lib/imap.js');
const gmail = { id:'gmail', receiveProtocol:'imap', email:'demo@gmail.com', imap:{host:'imap.gmail.com',user:'demo@gmail.com'}, smtp:{host:'smtp.gmail.com',user:'demo@gmail.com'} };
const regular = {id:'other',receiveProtocol:'imap',imap:{host:'imap.example.test'},smtp:{host:'smtp.example.test'}};
const listing = [
  {path:'INBOX',specialUse:'\\Inbox'}, {path:'[Gmail]/Tous les messages',specialUse:'\\All'},
  {path:'[Gmail]/Éléments envoyés',specialUse:'\\Sent'}, {path:'[Gmail]/Corbeille',flags:['\\Trash']},
  {path:'[Gmail]/Indésirables',specialUse:'\\Junk'}, {path:'[Gmail]/Brouillons',specialUse:'\\Drafts'},
  {path:'Trash'}, {path:'fake',specialUse:'\\Trash',selectable:false}, {path:'fake2',flags:['\\Trash','\\Noselect']},
];
const folders = gmailPolicy.folderMap(listing);
assert.deepEqual(folders,{inbox:'INBOX',sent:'[Gmail]/Éléments envoyés',trash:'[Gmail]/Corbeille',junk:'[Gmail]/Indésirables'});
assert.equal(gmailPolicy.folderMap([{path:'Trash'}]).trash,null);
assert.equal(gmailPolicy.folderMap([...listing,{path:'duplicate',specialUse:'\\Trash'}]).trash,null);
assert.equal(gmailPolicy.folderMap([{path:'INBOX',specialUse:'\\Trash'}]).trash,null);
assert.equal(gmailPolicy.folderMap([{path:'conflict',specialUse:'\\Trash',flags:['\\All']}]).trash,null);
assert.equal(gmailPolicy.folderMap([{path:'conflict',specialUse:'\\Trash'},{path:'conflict',specialUse:'\\All'}]).trash,null);
assert.equal(gmailPolicy.folderMap([{path:'conflict',specialUse:'\\Trash'},{path:'conflict',specialUse:'\\Sent'}]).trash,null);
assert(gmailPolicy.serverStoresSent(gmail));
assert(!gmailPolicy.serverStoresSent({...gmail,smtp:{...gmail.smtp,user:'other@gmail.com'}}));
assert(!gmailPolicy.serverStoresSent({...gmail,receiveProtocol:'pop3'}));
assert(!gmailPolicy.serverStoresSent({...gmail,smtp:{...gmail.smtp,host:'smtp.gmail.com.evil.test'}}));
assert(!gmailPolicy.isGmailImap({...gmail,imap:{host:'imap.gmail.com.evil.test'}}));
assert(!gmailPolicy.serverStoresSent(regular));

// Execute the actual IMAP functions with a simulated LIST and SMTP-copy lookup.
const extract = (source,start,end) => source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
let appended=0, found=[], searchFails=false;
const client={connect:async()=>{}, getMailboxLock:async()=>({release(){}}), search:async()=>{if(searchFails)throw Error('timeout');return found;}, append:async()=>{appended++;}};
const imapCtx=vm.createContext({gmailPolicy,listFolders:async()=>listing,buildFolderMap:()=>({legacy:true}),makeClient:()=>client,closeClientGracefully:async()=>{}});
const resolve=vm.runInContext(extract(imapSource,'async function resolveFolderMap(','async function serverAction(')+'\nresolveFolderMap',imapCtx);
const append=vm.runInContext(extract(imapSource,'async function appendSentCopy(','function clearWatchRetry(')+'\nappendSentCopy',imapCtx);

// Execute real destructive handlers against a simulated server and cache.
const calls=[], removed=[];let currentMap=folders, listError=false, rows=[];
const message=(id,folder,role,account=gmail)=>({id,account_id:account.id,folder,folder_role:role,uid:id});
const ctx=vm.createContext({gmailPolicy,accounts:[gmail],getAccount:id=>id===gmail.id?gmail:regular,
  groupMessages:vm.runInNewContext(extract(backend,'function groupMessages(','function isLocalImportedMessage(')+'\ngroupMessages'),
  isLocalImportedMessage:row=>row.folder.startsWith('Local/Imported'),
  ensureFolderMap:async(account,options)=>{calls.push(['list',account.id,Boolean(options?.force)]);if(listError)throw Error('offline');return currentMap;},
  imap:{deleteUids:async(a,f,u)=>calls.push(['delete',f,...u]),moveUids:async(a,f,u,t)=>calls.push(['move',f,t,...u]),emptyFolder:async(a,f)=>calls.push(['empty',f])},
  db:{deleteMessages:ids=>{removed.push(...ids);return ids;},listMessagesByRole:()=>rows,clearSyncState:()=>{},moveLocalMessages:()=>{}},
  removeLocalFiles(){},setTimeout:()=>({unref(){}}),
});
const move=vm.runInContext(extract(backend,'async function moveMessagesToTrash(','function resolveTrashRestoreSelection(')+'\nmoveMessagesToTrash',ctx);
const empty=vm.runInContext(extract(backend,'async function emptyTrash(','async function cleanupExpiredSpamForAccount(')+'\nemptyTrash',ctx);
(async()=>{
  assert.equal((await resolve(gmail)).trash,folders.trash);assert.equal((await resolve(regular)).legacy,true);
  assert.equal((await append(gmail,folders.sent,'raw','<id>')).reason,'server-managed');assert.equal(appended,0);
  searchFails=true;assert.equal((await append(gmail,folders.sent,'raw','<id>')).reason,'server-managed');assert.equal(appended,0);
  searchFails=false;found=[1];assert.equal((await append(gmail,folders.sent,'raw','<id>')).reason,'already-present');assert.equal(appended,0);
  found=[];assert((await append(regular,'Sent','raw','<id>')).appended);assert.equal(appended,1);
  assert((await append({...gmail,smtp:{...gmail.smtp,user:'other@gmail.com'}},folders.sent,'raw','<id>')).appended);assert.equal(appended,2);
  let r=await move([message(1,'INBOX','inbox'),message(2,folders.junk,'junk')]);
  assert.equal(r.processed,2);assert.equal(calls.filter(c=>c[0]==='list').length,1);assert(calls.filter(c=>c[0]==='list').every(c=>c[2]));assert.equal(calls.filter(c=>c[0]==='move').length,2);
  calls.length=removed.length=0;currentMap={...folders,trash:null};r=await move([message(3,'INBOX','inbox')]);assert.equal(r.errors.length,1);assert.equal(r.processed,0);assert.equal(removed.length,0);assert(!calls.some(c=>c[0]==='delete'||c[0]==='move'));
  currentMap=folders;calls.length=0;listError=true;r=await move([message(4,'INBOX','inbox')]);assert.equal(r.errors.length,1);assert.equal(removed.length,0);assert(!calls.some(c=>c[0]==='delete'||c[0]==='move'));listError=false;
  calls.length=0;r=await move([message(5,'old-trash','trash')]);assert.equal(r.errors.length,1);assert.equal(removed.length,0);
  calls.length=0;r=await move([message(6,folders.trash,'trash'),message(7,folders.trash,'inbox')]);assert.equal(r.errors.length,1);assert(!calls.some(c=>c[0]==='delete'));
  calls.length=0;r=await move([message(8,folders.trash,'trash')]);assert.equal(r.processed,1);assert(calls.some(c=>c[0]==='delete'&&c[1]===folders.trash));
  calls.length=removed.length=0;rows=[message(9,folders.trash,'trash'),message(10,'old-trash','trash')];r=await empty();assert.equal(r.deleted,1);assert.deepEqual(calls.filter(c=>c[0]==='empty'),[['empty',folders.trash]]);assert.deepEqual(removed,[9]);
  calls.length=removed.length=0;currentMap={...folders,trash:null};r=await empty();assert.equal(r.errors.length,1);assert.equal(r.deleted,0);assert(!calls.some(c=>c[0]==='empty'));
  calls.length=0;r=await move([message(11,'INBOX','inbox',regular)]);assert.equal(r.processed,1);assert(calls.some(c=>c[0]==='delete'),'legacy non-Gmail behavior unchanged');
  console.log('[OK] LibraMail 0.7.0 : Gmail SPECIAL-USE, protection de la corbeille, copies envoyées et cloisonnement');
})().catch(error=>{console.error(error);process.exitCode=1;});
