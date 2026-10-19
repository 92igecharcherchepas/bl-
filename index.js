require('dotenv').config();
const fs = require('fs');
const {
  Client, GatewayIntentBits, MessageFlags,
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize,
} = require('discord.js');

const PREFIX = '&';
const GRAY = 0x808080;
// Un ou plusieurs owners séparés par des virgules dans le .env
const OWNERS = (process.env.OWNER || '').split(',').map(s => s.trim()).filter(Boolean);
const BL_FILE = './blacklist.json';
const ACCESS_FILE = './access.json';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ───────────── Stockage ─────────────
const load = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
const save = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));
let blacklist = load(BL_FILE);
let access = load(ACCESS_FILE); // { guildId: [roleId, ...] }

// ───────────── Components V2 (full gris) ─────────────
const panel = (title, lines = []) => {
  const container = new ContainerBuilder()
    .setAccentColor(GRAY)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`### ${title}`));
  if (lines.length) {
    container
      .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));
  }
  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
  };
};

// ───────────── Accès ─────────────
const isOwner = (msg) => OWNERS.includes(msg.author.id);
const hasAccess = (msg) =>
  isOwner(msg) || msg.member.roles.cache.some(r => (access[msg.guild.id] || []).includes(r.id));
const deny = (msg, ownerOnly = false) =>
  msg.reply(panel('Accès refusé', [ownerOnly
    ? 'Cette commande est réservée aux owners du bot.'
    : 'Tu n’as pas de rôle autorisé à utiliser cette commande.']));

// ───────────── Utilitaires ─────────────
const parseDuration = (str) => {
  const m = /^(\d+)(s|m|h|d)$/i.exec(str || '');
  if (!m) return null;
  const mult = { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2].toLowerCase()];
  const ms = parseInt(m[1]) * mult;
  return ms > 0 && ms <= 28 * 864e5 ? ms : null; // max 28 jours (limite Discord)
};

const resolveUser = async (msg, arg) => {
  const mentioned = msg.mentions.users.first();
  if (mentioned) return mentioned;
  if (!arg || !/^\d{15,22}$/.test(arg)) return null;
  return client.users.fetch(arg).catch(() => null);
};

const resolveRole = (msg, arg) =>
  msg.mentions.roles.first() || (arg && msg.guild.roles.cache.get(arg)) || null;

const outranked = (msg, member) =>
  !isOwner(msg) && msg.guild.ownerId !== msg.author.id &&
  msg.member.roles.highest.position <= member.roles.highest.position;

// ───────────── Commandes ─────────────
const commands = {
  async help(msg) {
    return msg.reply(panel('Commandes', [
      `\`${PREFIX}ban <@user/id> [raison]\` — Bannir un membre`,
      `\`${PREFIX}unban <id> [raison]\` — Débannir`,
      `\`${PREFIX}mute <@user/id> <10m|1h|1d> [raison]\` — Mute (timeout)`,
      `\`${PREFIX}unmute <@user/id>\` — Retirer le mute`,
      `\`${PREFIX}acces <add|remove|list> [@role]\` — Gérer les rôles autorisés *(owner)*`,
      `\`${PREFIX}bl <@user/id> [raison]\` — Blacklist globale *(owner)*`,
      `\`${PREFIX}unbl <id>\` — Retirer de la blacklist *(owner)*`,
      `\`${PREFIX}bllist\` — Voir la blacklist *(owner)*`,
    ]));
  },

  async acces(msg, args) {
    if (!isOwner(msg)) return deny(msg, true);
    const sub = args[0]?.toLowerCase();
    const list = access[msg.guild.id] || [];

    if (sub === 'list') {
      return msg.reply(panel('Rôles autorisés', list.length
        ? list.map(id => `• <@&${id}>`)
        : ['Aucun rôle configuré. Seuls les owners ont accès.']));
    }
    if (sub === 'add' || sub === 'remove') {
      const role = resolveRole(msg, args[1]);
      if (!role) return msg.reply(panel('Utilisation', [`\`${PREFIX}acces ${sub} <@role/id>\``]));
      if (sub === 'add') {
        if (list.includes(role.id)) return msg.reply(panel('Déjà autorisé', [`${role} a déjà accès.`]));
        access[msg.guild.id] = [...list, role.id];
      } else {
        if (!list.includes(role.id)) return msg.reply(panel('Introuvable', [`${role} n’a pas accès.`]));
        access[msg.guild.id] = list.filter(id => id !== role.id);
      }
      save(ACCESS_FILE, access);
      return msg.reply(panel(sub === 'add' ? 'Accès accordé' : 'Accès retiré', [
        `**Rôle :** ${role}`,
        'Commandes concernées : `ban`, `unban`, `mute`, `unmute`',
      ]));
    }
    return msg.reply(panel('Utilisation', [
      `\`${PREFIX}acces add <@role/id>\``,
      `\`${PREFIX}acces remove <@role/id>\``,
      `\`${PREFIX}acces list\``,
    ]));
  },

  async ban(msg, args) {
    if (!hasAccess(msg)) return deny(msg);
    const user = await resolveUser(msg, args[0]);
    if (!user) return msg.reply(panel('Utilisation', [`\`${PREFIX}ban <@user/id> [raison]\``]));
    const reason = args.slice(1).join(' ') || 'Aucune raison';

    const member = await msg.guild.members.fetch(user.id).catch(() => null);
    if (member) {
      if (!member.bannable)
        return msg.reply(panel('Impossible', ['Je ne peux pas bannir ce membre (rôle trop haut).']));
      if (outranked(msg, member))
        return msg.reply(panel('Impossible', ['Ce membre a un rôle égal ou supérieur au tien.']));
    }
    await msg.guild.members.ban(user.id, { reason: `${msg.author.tag} : ${reason}` })
      .then(() => msg.reply(panel('Membre banni', [`**Membre :** ${user.tag} (\`${user.id}\`)`, `**Modérateur :** ${msg.author}`, `**Raison :** ${reason}`])))
      .catch(() => msg.reply(panel('Erreur', ['Le bannissement a échoué.'])));
  },

  async unban(msg, args) {
    if (!hasAccess(msg)) return deny(msg);
    const id = args[0];
    if (!/^\d{15,22}$/.test(id || '')) return msg.reply(panel('Utilisation', [`\`${PREFIX}unban <id> [raison]\``]));
    const reason = args.slice(1).join(' ') || 'Aucune raison';
    await msg.guild.members.unban(id, `${msg.author.tag} : ${reason}`)
      .then(() => msg.reply(panel('Membre débanni', [`**ID :** \`${id}\``, `**Modérateur :** ${msg.author}`])))
      .catch(() => msg.reply(panel('Erreur', ['Cet utilisateur n’est pas banni.'])));
  },

  async mute(msg, args) {
    if (!hasAccess(msg)) return deny(msg);
    const user = await resolveUser(msg, args[0]);
    const ms = parseDuration(args[1]);
    if (!user || !ms)
      return msg.reply(panel('Utilisation', [`\`${PREFIX}mute <@user/id> <10m|1h|1d> [raison]\``, 'Durée max : 28 jours.']));
    const reason = args.slice(2).join(' ') || 'Aucune raison';

    const member = await msg.guild.members.fetch(user.id).catch(() => null);
    if (!member) return msg.reply(panel('Introuvable', ['Ce membre n’est pas sur le serveur.']));
    if (!member.moderatable)
      return msg.reply(panel('Impossible', ['Je ne peux pas mute ce membre (rôle trop haut ou administrateur).']));
    if (outranked(msg, member))
      return msg.reply(panel('Impossible', ['Ce membre a un rôle égal ou supérieur au tien.']));

    await member.timeout(ms, `${msg.author.tag} : ${reason}`)
      .then(() => msg.reply(panel('Membre mute', [
        `**Membre :** ${user.tag} (\`${user.id}\`)`,
        `**Fin :** <t:${Math.floor((Date.now() + ms) / 1000)}:R>`,
        `**Modérateur :** ${msg.author}`,
        `**Raison :** ${reason}`,
      ])))
      .catch(() => msg.reply(panel('Erreur', ['Le mute a échoué.'])));
  },

  async unmute(msg, args) {
    if (!hasAccess(msg)) return deny(msg);
    const user = await resolveUser(msg, args[0]);
    if (!user) return msg.reply(panel('Utilisation', [`\`${PREFIX}unmute <@user/id>\``]));
    const member = await msg.guild.members.fetch(user.id).catch(() => null);
    if (!member) return msg.reply(panel('Introuvable', ['Ce membre n’est pas sur le serveur.']));
    await member.timeout(null, `Unmute par ${msg.author.tag}`)
      .then(() => msg.reply(panel('Mute retiré', [`**Membre :** ${user.tag}`, `**Modérateur :** ${msg.author}`])))
      .catch(() => msg.reply(panel('Erreur', ['Impossible de retirer le mute.'])));
  },

  async bl(msg, args) {
    if (!isOwner(msg)) return deny(msg, true);
    const user = await resolveUser(msg, args[0]);
    if (!user) return msg.reply(panel('Utilisation', [`\`${PREFIX}bl <@user/id> [raison]\``]));
    if (OWNERS.includes(user.id)) return msg.reply(panel('Impossible', ['Tu ne peux pas blacklist un owner.']));
    const reason = args.slice(1).join(' ') || 'Aucune raison';

    blacklist[user.id] = { tag: user.tag, reason, by: msg.author.id, at: Date.now() };
    save(BL_FILE, blacklist);

    let banned = 0;
    for (const guild of client.guilds.cache.values()) {
      const ok = await guild.members.ban(user.id, { reason: `[BL] ${reason}` }).then(() => true).catch(() => false);
      if (ok) banned++;
    }
    return msg.reply(panel('Utilisateur blacklist', [
      `**Utilisateur :** ${user.tag} (\`${user.id}\`)`,
      `**Raison :** ${reason}`,
      `**Banni sur :** ${banned}/${client.guilds.cache.size} serveur(s)`,
    ]));
  },

  async unbl(msg, args) {
    if (!isOwner(msg)) return deny(msg, true);
    const id = args[0];
    if (!blacklist[id]) return msg.reply(panel('Introuvable', ['Cet ID n’est pas dans la blacklist.']));
    delete blacklist[id];
    save(BL_FILE, blacklist);
    for (const guild of client.guilds.cache.values()) await guild.members.unban(id, 'Retiré de la blacklist').catch(() => {});
    return msg.reply(panel('Blacklist retirée', [`**ID :** \`${id}\``, 'Débanni des serveurs où c’était possible.']));
  },

  async bllist(msg) {
    if (!isOwner(msg)) return deny(msg, true);
    const entries = Object.entries(blacklist);
    if (!entries.length) return msg.reply(panel('Blacklist', ['La blacklist est vide.']));
    const lines = entries.slice(0, 25).map(([id, d]) => `• **${d.tag}** (\`${id}\`) — ${d.reason}`);
    if (entries.length > 25) lines.push(`… et ${entries.length - 25} autre(s)`);
    return msg.reply(panel(`Blacklist (${entries.length})`, lines));
  },
};

// ───────────── Événements ─────────────
client.once('clientReady', () => console.log(`Connecté en tant que ${client.user.tag}`));

client.on('guildMemberAdd', async (member) => {
  const entry = blacklist[member.id];
  if (entry) await member.ban({ reason: `[BL] ${entry.reason}` }).catch(() => {});
});

client.on('messageCreate', async (msg) => {
  if (msg.author.bot || !msg.guild || !msg.content.startsWith(PREFIX)) return;
  if (!msg.member) await msg.guild.members.fetch(msg.author.id).catch(() => {});
  const args = msg.content.slice(PREFIX.length).trim().split(/\s+/);
  const name = args.shift()?.toLowerCase();
  const cmd = commands[name];
  if (!cmd) return;
  try { await cmd(msg, args); }
  catch (err) {
    console.error(err);
    msg.reply(panel('Erreur', ['Une erreur est survenue.'])).catch(() => {});
  }
});

client.login(process.env.TOKEN);