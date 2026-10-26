(() => {
    "use strict";
    // Midnight Layout - step 1: layout scanner.
    // Watches which screen components Discord actually draws on this device, so the next
    // version can give the right ones midnight's rounded, floating-panel look.
    // Hooks only count renders and describe the root element; they never change output.

    const { metro, patcher, plugin } = vendetta;
    const { storage } = plugin;
    const { React, ReactNative } = metro.common;
    const { View, Text, ScrollView, Pressable, StyleSheet } = ReactNative;
    const h = React.createElement;

    const VERSION = "0.1.0";
    const RX = /(channel_list|guild_sidebar\/native|messages\/native\/(Messages|Chat)|chat_input|chat\/native|home\/native|home_drawer\/native\/HomeDrawer(?!FolderRow|GuildRow)|private_channels|main_tabs|tabs_v2|bottom_tabs|navigation\/native|guilds_bar\/native\/GuildsBar\.tsx|user_profile\/native\/UserPanel|panels\/native|you_tab|notifications\/native\/Notifications|channel\/native\/Channel)/i;

    const safe = (fn, fb) => {
        try {
            const r = fn();
            return r === undefined ? fb : r;
        } catch (e) {
            return fb;
        }
    };
    const toast = (m) => safe(() => vendetta.ui.toasts.showToast(m));

    const hooked = new Map(); // key -> record
    const unpatches = [];
    let stopped = false;

    function describeRoot(res) {
        return safe(() => {
            let n = res;
            for (let i = 0; i < 3 && n && n.props && !n.props.style && n.props.children && !Array.isArray(n.props.children); i++) n = n.props.children;
            if (!n || !n.props) return String(n);
            const t = n.type;
            const name = typeof t === "string" ? t : t && (t.displayName || t.name || (t.render && t.render.name) || (t.$$typeof ? "memo/fwd" : typeof t));
            const st = safe(() => StyleSheet.flatten(n.props.style), {}) || {};
            const keep = ["flex", "backgroundColor", "borderRadius", "margin", "marginTop", "padding", "paddingTop", "width", "height", "position"];
            const style = keep.filter((k) => st[k] !== undefined).map((k) => `${k}:${st[k]}`).join(" ");
            return `${name || "?"}${style ? " {" + style + "}" : ""}`;
        }, "?");
    }

    function hookExport(path, id, exp, key) {
        const comp = safe(() => exp[key]);
        if (!comp) return;
        const rec = { path, key, renders: 0, root: "", via: "" };
        const cb = (args, res) => {
            rec.renders++;
            if (!rec.root || rec.renders % 20 === 0) rec.root = describeRoot(res);
            return res;
        };
        let un = null;
        safe(() => {
            if (typeof comp === "function" && !(comp.prototype && comp.prototype.isReactComponent)) {
                un = patcher.after(key, exp, cb);
                rec.via = "fn";
            } else if (comp && comp.prototype && comp.prototype.render) {
                un = patcher.after("render", comp.prototype, cb);
                rec.via = "class";
            } else if (comp && typeof comp.render === "function") {
                un = patcher.after("render", comp, cb);
                rec.via = "fwd";
            } else if (comp && comp.type && typeof comp.type.render === "function") {
                un = patcher.after("render", comp.type, cb);
                rec.via = "memo(fwd)";
            } else if (comp && typeof comp.type === "function") {
                un = patcher.after("type", comp, cb);
                rec.via = "memo";
            }
        });
        if (un) {
            unpatches.push(un);
            hooked.set(`${id}:${key}`, rec);
        }
    }

    function sweep() {
        const mods = safe(() => vendetta.metro.modules || window.modules, {}) || {};
        let added = 0;
        for (const id in mods) {
            if (hooked.size > 160) break;
            const m = mods[id];
            const path = m && m.__filePath;
            if (!path || !RX.test(path) || !/\.tsx$/.test(path)) continue;
            const exp = safe(() => m.publicModule.exports);
            if (!exp || typeof exp !== "object") continue;
            for (const key of safe(() => Object.keys(exp), []).slice(0, 6)) {
                if (hooked.has(`${id}:${key}`)) continue;
                const v = safe(() => exp[key]);
                const isComp = typeof v === "function" || (v && typeof v === "object" && v.$$typeof);
                if (!isComp) continue;
                if (typeof v === "function" && /^use[A-Z]/.test(key)) continue; // skip hooks
                hookExport(path, id, exp, key);
                added++;
            }
        }
        return added;
    }

    function report() {
        const rows = [...hooked.values()].sort((a, b) => b.renders - a.renders);
        const lines = rows.map((r) => `${r.renders}× ${r.path} :: ${r.key} [${r.via}] ${r.renders ? "→ " + r.root : ""}`);
        const dims = safe(() => {
            const d = ReactNative.Dimensions.get("window");
            return `${Math.round(d.width)}x${Math.round(d.height)}`;
        }, "?");
        return `Midnight Layout ${VERSION} report · screen ${dims} · ${rows.length} hooked, ${rows.filter((r) => r.renders).length} drawn\n` + lines.slice(0, 120).join("\n");
    }

    function Settings() {
        const [out, setOut] = React.useState(null);
        const [, force] = React.useReducer((x) => x + 1, 0);
        const btn = (label, onPress) =>
            h(
                Pressable,
                { onPress, style: { margin: 16, marginBottom: 0, padding: 14, borderRadius: 12, backgroundColor: "#3673CB", alignItems: "center" } },
                h(Text, { style: { color: "#FFFFFF", fontSize: 16, fontWeight: "700" } }, label),
            );
        return h(
            ScrollView,
            { style: { flex: 1 } },
            h(
                Text,
                { style: { color: "#8592AD", fontSize: 14, padding: 16, lineHeight: 20 } },
                "Step 1 of the midnight look. Use the app normally for a minute: open the server list, a server's channel list, a chat, your DMs, Notifications and the You tab. Then come back here and tap Copy report, and paste it to Claude.",
            ),
            btn("Copy report", () => {
                sweep();
                const r = report();
                setOut(r);
                const ok = safe(() => {
                    metro.common.clipboard.setString(r);
                    return true;
                }, false);
                toast(ok ? "Report copied - paste it to Claude" : "Screenshot the report below");
            }),
            btn("Rescan", () => {
                const n = sweep();
                toast(`Midnight Layout: ${n} new parts hooked (${hooked.size} total)`);
                force();
            }),
            h(Text, { style: { color: "#8592AD", fontSize: 12, padding: 16 } }, `${hooked.size} parts hooked`),
            out ? h(Text, { selectable: true, style: { color: "#8592AD", fontSize: 11, paddingHorizontal: 16, paddingBottom: 40, fontFamily: "Menlo" } }, out) : null,
        );
    }

    let timer = null;
    return {
        onLoad() {
            stopped = false;
            let tries = 0;
            const loop = () => {
                if (stopped) return;
                safe(sweep);
                if (++tries < 40) timer = setTimeout(loop, 3000); // keep catching screens as they load (2 min)
            };
            loop();
            toast(`Midnight Layout ${VERSION}: browse the app, then copy the report from its settings`);
        },
        onUnload() {
            stopped = true;
            if (timer) clearTimeout(timer);
            unpatches.splice(0).forEach((u) => safe(u));
            hooked.clear();
        },
        settings: Settings,
    };
})()
