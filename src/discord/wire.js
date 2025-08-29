// src/discord/wire.js
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { MessageFlags } from "discord.js";
import { getChannelSnapshot, getRoleSnapshot, snapshotCounts } from "../../utils/snapshot-store.js";
import { formatChannelSnapshot, formatRoleSnapshot } from "../../utils/snapshot-format.js";

// ... keep the rest of your helpers and other commands exactly as-is ...

export async function wire(client) {
  client.on("interactionCreate", async (i) => {
    try {
      if (!i.isChatInputCommand()) return;
      const featuresPath = path.join(process.cwd(), "data", "feature-flags.json");
      const stripBOM = (s)=>typeof s==="string"?s.replace(/^\uFEFF/,""):s;
      const readJSONSafe = async (f)=>{try{return JSON.parse(stripBOM(await fs.readFile(f,"utf8")));}catch{return {};}}
      const features = await readJSONSafe(featuresPath);
      const allowRestore = !!(typeof features.slashRestorePreview === "boolean" ? features.slashRestorePreview : true);

      // --- ONLY the restorepreview block below is new/changed ---
      if (i.commandName === "restorepreview" && allowRestore) {
        const id = i.options.getString("id");
        if (!id) {
          const cnt = await snapshotCounts();
          await i.reply({ content: "```json\n" + JSON.stringify(cnt, null, 2) + "\n```", flags: MessageFlags.Ephemeral });
          return;
        }
        const ch = await getChannelSnapshot(i.guildId, id);
        const rl = ch ? null : await getRoleSnapshot(i.guildId, id);

        if (!ch && !rl) {
          await i.reply({ content: "```json\n" + JSON.stringify({ error: `no snapshot found for id=${id}` }, null, 2) + "\n```", flags: MessageFlags.Ephemeral });
          return;
        }

        const payload = ch ? { kind: "channel", snapshot: ch } : { kind: "role", snapshot: rl };
        const summary = ch ? formatChannelSnapshot(i.guild, ch) : formatRoleSnapshot(i.guild, rl);

        const jsonPart = "```json\n" + JSON.stringify(payload, null, 2).slice(0, 900) + "\n```";
        const txtPart  = "```txt\n"  + String(summary).slice(0, 900) + "\n```";
        await i.reply({ content: jsonPart + "\n" + txtPart, flags: MessageFlags.Ephemeral });
        return;
      }

      // ... all your other commands remain unchanged ...

    } catch {
      try { await i.reply({ content: "Command failed. Check logs.", flags: MessageFlags.Ephemeral }); } catch {}
    }
  });

  // keep your existing clientReady registration code as-is
}

export default { wire };
