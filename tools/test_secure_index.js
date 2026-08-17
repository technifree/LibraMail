'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../engine/lib/db');
const mailStore = require('../engine/lib/mail_store');
const credentialStore = require('../engine/lib/credential_store');

const secrets = new Map();
credentialStore.readServiceSecret = name => secrets.get(String(name)) || '';
credentialStore.writeServiceSecret = (name, value) => { secrets.set(String(name), String(value)); return true; };
credentialStore.removeServiceSecret = name => secrets.delete(String(name));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'libramail-secure-index-'));
const indexFile = path.join(root, 'index.db');
try {
  db.init(root);
  mailStore.init(root);

  const text = 'Rendez-vous confidentiel chez le cardiologue vendredi matin.';
  const row = {
    account_id:'acc', folder:'INBOX', folder_role:'inbox', uid:1, message_id:'<one@test>',
    subject:'Compte rendu médical', from_name:'Alice', from_addr:'alice@example.test', to_addr:'vince@example.test',
    date:Date.now(), snippet:mailStore.protectSnippet('acc', text.slice(0,160)), seen:0, flagged:0, answered:0,
    has_attach:0, is_spam:0, size:123, eml_path:'', thread_key:'t1', in_reply_to:null, references_json:'[]',
  };
  const {id}=db.upsertMessage(row);
  const raw=Buffer.from('From: Alice <alice@example.test>\r\nTo: Vince <vince@example.test>\r\nSubject: Compte rendu médical\r\n\r\n'+text);
  const descriptor=mailStore.storeMessage({...row,id},raw);
  db.setMessageStorage(id,descriptor);
  db.indexBody(id,row,'',{secureTokens:mailStore.searchTokens(text)});

  const stored=db.db.prepare('SELECT snippet FROM messages WHERE id=?').get(id).snippet;
  if (!String(stored).startsWith('enc1:') || String(stored).includes('cardiologue')) throw new Error('Snippet non chiffré');
  const rows=db.listMessages({});
  if (rows[0].snippet !== text.slice(0,160)) throw new Error('Snippet non déchiffré à la lecture');
  if (db.listConversations({}).length !== 1) throw new Error('Liste des conversations invalide');
  const bodyResult=db.search('cardiologue',{bodyTokens:mailStore.searchTokens('cardiologue')});
  if (bodyResult.length !== 1) throw new Error('Recherche sécurisée du corps invalide');
  const metadataResult=db.search('médical',{bodyTokens:mailStore.searchTokens('médical')});
  if (metadataResult.length !== 1) throw new Error('Recherche métadonnée invalide');
  const tokens=db.db.prepare('SELECT token FROM secure_body_tokens WHERE message_id=?').all(id);
  if (!tokens.length || tokens.some(item => /cardiologue/i.test(item.token))) throw new Error('Jetons de recherche non sécurisés');

  // Simule l'index 0.3.x : snippet et corps en clair, puis vérifie que la
  // reconstruction + VACUUM font disparaître le texte des pages SQLite.
  const canary='vaultplaintextcanary998';
  const old={...row, uid:2, message_id:'<old@test>', subject:'Historique', snippet:canary, thread_key:'t2'};
  const {id:oldId}=db.upsertMessage(old);
  db.indexBody(oldId,old,`ancien corps ${canary}`);
  try { db.db.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
  db.resetSecureSearchIndex();
  db.setEncryptedSnippet(oldId,mailStore.protectSnippet('acc',canary));
  db.indexBody(oldId,old,'',{secureTokens:mailStore.searchTokens(`ancien corps ${canary}`)});
  db.indexBody(id,row,'',{secureTokens:mailStore.searchTokens(text)});
  db.vacuum();
  const disk=fs.readFileSync(indexFile).toString('latin1');
  if (disk.includes(canary)) throw new Error('Ancien corps/snippet encore présent en clair après VACUUM');
  const oldRead=db.getMessage(oldId);
  if (oldRead.snippet !== canary) throw new Error('Snippet historique non déchiffré');
  const oldSearch=db.search(canary,{bodyTokens:mailStore.searchTokens(canary)});
  if (!oldSearch.some(item=>item.id===oldId)) throw new Error('Recherche historique sécurisée invalide');

  console.log('[LibraMail] Test index de recherche sécurisé : OK');
} finally {
  try { mailStore.close(); } catch {}
  try { db.close(); } catch {}
  fs.rmSync(root,{recursive:true,force:true});
}
