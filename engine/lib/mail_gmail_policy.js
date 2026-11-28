'use strict';

const host = value => String(value || '').trim().toLowerCase();
const user = value => String(value || '').trim().toLowerCase();

function isGmailImap(account) {
  return account?.receiveProtocol !== 'pop3' && host(account?.imap?.host) === 'imap.gmail.com';
}

function serverStoresSent(account) {
  if (!isGmailImap(account) || host(account?.smtp?.host) !== 'smtp.gmail.com') return false;
  const incoming = user(account.imap?.user || account.email);
  const outgoing = user(account.smtp?.user || account.pop3?.user || account.imap?.user || account.email);
  return Boolean(incoming && incoming === outgoing);
}

// Gmail's LIST special-use attributes are authoritative. Never guess a
// destructive destination from a translated name or a user-created label.
function folderMap(folders) {
  const matches = { sent: new Set(), trash: new Set(), junk: new Set() };
  const records = Array.isArray(folders) ? folders : [];
  const blocked = new Set();
  for (const folder of records) {
    if (!folder || typeof folder.path !== 'string' || !folder.path.trim()) continue;
    const flags = new Set([folder.specialUse, ...Array.from(folder.flags || [])]
      .map(flag => String(flag || '').toLowerCase()));
    if (folder.selectable === false || flags.has('\\noselect') || flags.has('\\nonexistent')) { blocked.add(folder.path); continue; }
    if (folder.path.toUpperCase() === 'INBOX') continue;
    // Never map All Mail, Drafts, Important or Starred to a destructive role.
    if (['\\all','\\allmail','\\drafts','\\important','\\flagged','\\inbox','\\archive'].some(f => flags.has(f))) { blocked.add(folder.path); continue; }
    const roles = Object.entries({ sent: '\\sent', trash: '\\trash', junk: '\\junk' })
      .filter(([, flag]) => flags.has(flag)).map(([role]) => role);
    if (roles.length === 1) matches[roles[0]].add(folder.path);
    else if (roles.length > 1) blocked.add(folder.path);
  }
  const map = { inbox: 'INBOX', sent: null, trash: null, junk: null };
  for (const [role, paths] of Object.entries(matches)) {
    if (paths.size === 1) map[role] = [...paths][0];
  }
  for (const role of Object.keys(matches)) {
    if (map[role] && (blocked.has(map[role]) || Object.keys(matches).some(other => other !== role && matches[other].has(map[role])))) map[role] = null;
  }
  return map;
}

function requireTrash(map) {
  if (typeof map?.trash !== 'string' || !map.trash.trim() || map.trash.toUpperCase() === 'INBOX' ||
      [map.sent, map.junk].includes(map.trash)) {
    throw new Error('Corbeille Gmail non identifiée par le serveur IMAP. Aucune suppression effectuée.');
  }
  return map.trash;
}

function deletionMode(map, message) {
  const trash = requireTrash(map);
  if (message.folder === trash && message.folder_role === 'trash') return 'delete';
  if (message.folder === trash || message.folder_role === 'trash') {
    throw new Error('Dossier Gmail incohérent. Actualisez le compte avant de supprimer ce message.');
  }
  return 'move';
}

module.exports = { isGmailImap, serverStoresSent, folderMap, requireTrash, deletionMode };
