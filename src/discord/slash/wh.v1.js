// src/discord/slash/wh.v1.js
// Guild-scoped test command to create/update/delete a webhook in a chosen channel.
// All replies are ephemeral and we ALWAYS defer to avoid "application did not respond".

import { ChannelType, MessageFlags, PermissionFlagsBits } from "discord.js";
import createLogger from "../../utils/pino-factory.js";
import path from "node:path";
import fs from "node:fs/promises";

const log = createLogger("slash.wh");

function stripBOM(s){ return typeof s === "string" ? s.replace(/^\uFEFF/, "") : s; }
async function readJSONSafe(file){ try { return JSON.parse(stripBOM(await fs.readFile(file, "utf8"))); } catch { return {}; } }
function normBool(v, fb = true){ if (typeof v === "boolean") return v; if (typeof v === "string") return v.toLowerCase() === "true"; return fb; }

function channelSupportsWebhooks(ch) {
  if (!ch) return false;
  // Text & Announcement channels (not voice, stage, forum, thread)
  return ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement;
}

async function registerSlash(client) {
  const features = await readJSONSafe(path.join(process.cwd(), "data", "feature-flags.json"));
  const enabled = normBool(features.slashWebhookTest, false);
  if (!enabled) {
    log.info("slash /wh disabled by flag (set feature-flags.slashWebhookTest=true to enable)");
    return;
  }

  const def = {
    name: "wh",
    description: "Create/Update/Delete a webhook in a channel (TEST ONLY)",
    dm_permission: false,
    default_member_permissions: String(PermissionFlagsBits.ManageGuild), // sensible default
    options: [
      {
        type: 1, // SUB_COMMAND: create
        name: "create",
        description: "Create a webhook in the given channel",
        options: [
          { type: 7, name: "channel", description: "Target channel (text/announcement)", required: true },
          { type: 3, name: "name",    description: "Webhook name", required: false }
        ]
      },
      {
        type: 1, // SUB_COMMAND: update
        name: "update",
        description: "Update the first webhook found in the given channel",
        options: [
          { type: 7, name: "channel", description: "Target channel", required: true },
          { type: 3, name: "name",    description: "New webhook name", required: true }
        ]
      },
      {
        type: 1, // SUB_COMMAND: delete
        name: "delete",
        description: "Delete the first webhook found in the given channel",
        options: [
          { type: 7, name: "channel", description: "Target channel", required: true }
        ]
      },
      {
        type: 1, // SUB_COMMAND: status
        name: "status",
        description: "List webhooks in the given channel",
        options: [
          { type: 7, name: "channel", description: "Target channel", required: true }
        ]
      }
    ]
  };

  // Register into every joined guild (same pattern as your other slash defs)
  for (const [guildId] of client.guilds.cache) {
    try { await client.application.commands.create(def, guildId); }
    catch (err) { log.warn({ guildId, err: String(err?.message || err) }, "/wh register failed"); }
  }
  log.info("/wh registered (guild)");
}

export default function wireWebhookTestSlash(client) {
  client.once("clientReady", () => { registerSlash(client).catch(()=>{}); });

  client.on("interactionCreate", async (i) => {
    try {
      if (!i.isChatInputCommand()) return;
      if (i.commandName !== "wh") return;

      // Only allow Manage Guild users
      const member = i.member;
      const canManage = member?.permissions?.has?.("ManageGuild") || member?.permissions?.has?.("Administrator");
      if (!canManage) { await i.reply({ content: "Need **Manage Server**.", flags: MessageFlags.Ephemeral }); return; }

      await i.deferReply({ flags: MessageFlags.Ephemeral });

      const sub = i.options.getSubcommand();
      const ch  = i.options.getChannel("channel");
      if (!channelSupportsWebhooks(ch)) {
        await i.editReply("This channel type does not support webhooks. Use a Text or Announcement channel.");
        return;
      }

      if (!ch.permissionsFor?.(i.client.user?.id)?.has?.(PermissionFlagsBits.ManageWebhooks)) {
        await i.editReply("I need **Manage Webhooks** permission in that channel.");
        return;
      }

      if (sub === "create") {
        const name = i.options.getString("name") || "Hook Test";
        try {
          const wh = await ch.createWebhook({ name });
          await i.editReply("```json\n" + JSON.stringify({ ok: true, action: "create", channelId: ch.id, webhookId: wh.id, name: wh.name }, null, 2) + "\n```");
        } catch (err) {
          await i.editReply("```json\n" + JSON.stringify({ ok: false, action: "create", error: String(err?.message || err) }, null, 2) + "\n```");
        }
        return;
      }

      // find first webhook in the channel
      const list = await ch.fetchWebhooks().catch(()=>null);
      const first = list && list.first();
      if (!first) {
        await i.editReply("No webhook found in that channel.");
        return;
      }

      if (sub === "update") {
        const name = i.options.getString("name");
        try {
          const wh = await first.edit({ name });
          await i.editReply("```json\n" + JSON.stringify({ ok: true, action: "update", channelId: ch.id, webhookId: wh.id, name: wh.name }, null, 2) + "\n```");
        } catch (err) {
          await i.editReply("```json\n" + JSON.stringify({ ok: false, action: "update", error: String(err?.message || err) }, null, 2) + "\n```");
        }
        return;
      }

      if (sub === "delete") {
        try {
          await first.delete("wh test delete");
          await i.editReply("```json\n" + JSON.stringify({ ok: true, action: "delete", channelId: ch.id, webhookId: first.id }, null, 2) + "\n```");
        } catch (err) {
          await i.editReply("```json\n" + JSON.stringify({ ok: false, action: "delete", error: String(err?.message || err) }, null, 2) + "\n```");
        }
        return;
      }

      if (sub === "status") {
        const all = list ? Array.from(list.values()).map(w => ({ id: w.id, name: w.name, url: w.url?.slice?.(0, 40) + "…" })) : [];
        await i.editReply("```json\n" + JSON.stringify({ ok: true, action: "status", channelId: ch.id, count: all.length, webhooks: all }, null, 2) + "\n```");
        return;
      }

      await i.editReply("Unknown subcommand.");
    } catch (err) {
      // Try to respond even if something blew up
      try {
        if (typeof i.deferReply === "function" && !i.deferred && !i.replied) {
          await i.reply({ content: "wh error. Check logs.", flags: MessageFlags.Ephemeral });
        } else if (i.deferred && !i.replied) {
          await i.editReply("wh error. Check logs.");
        }
      } catch {}
      log.warn({ err: String(err?.stack || err) }, "/wh handler failed");
    }
  });
}
