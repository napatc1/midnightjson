(() => {
    "use strict";
    // BetterFolders, rebuilt for Kettu. Original idea and code by fres (fres621/vendetta-plugins).
    // Folder column inspired by Vencord's BetterFolders.
    // Every lookup is guarded so a missing Discord internal disables one feature
    // instead of crashing the whole plugin.

    const { metro, patcher, plugin, logger } = vendetta;
    const { storage } = plugin;
    const { React, ReactNative, FluxDispatcher } = metro.common;
    const { View, Text, Image, ScrollView, Switch, Pressable, Modal, Linking } = ReactNative;

    const VERSION = "1.2.1";
    const status = { autoCollapse: "not started", hideIcons: "not started", column: "not started", nav: "unused" };
    const stats = { renders: 0, previewPatched: 0, hostAttached: 0, hostMounted: false, attachMode: "none" };
    const unpatches = [];

    const COLORS = {
        panel: "#171B2B", border: "#4B5B9B33", text: "#E6EAF5", sub: "#8A93AD",
        selected: "#3673CB", tile: "#1D2135",
    };

    const safe = (fn, fallback) => {
        try {
            const r = fn();
            return r === undefined ? fallback : r;
        } catch (e) {
            return fallback;
        }
    };

    const asset = (name) => safe(() => vendetta.ui.assets.getAssetIDByName(name));
    const toast = (msg) => safe(() => vendetta.ui.toasts.showToast(msg, asset("img_guild_folder")));
    const h = React.createElement;

    // ── store lookups (with fallbacks for renamed stores) ─────────────────
    const ExpandedStore = safe(() => metro.findByStoreName("ExpandedGuildFolderStore"));
    const GuildStore = safe(() => metro.findByStoreName("GuildStore"));
    const SelectedGuildStore = safe(() => metro.findByStoreName("SelectedGuildStore"));
    const folderSources = [
        () => metro.findByStoreName("SortedGuildStore"),
        () => metro.findByStoreName("UserSettingsProtoStore"),
        () => metro.findByStoreName("GuildFolderStore"),
    ];

    function getFolders() {
        for (const src of folderSources) {
            const store = safe(src);
            const list = safe(() => store.getGuildFolders());
            if (Array.isArray(list)) return list;
        }
        return null;
    }

    const getFolder = (id) => safe(() => (getFolders() || []).find((f) => f.folderId === id), null);
    const isExpanded = (id) => !!safe(() => ExpandedStore.isFolderExpanded(id), false);
    let internalToggle = false;
    const toggle = (folderId) => {
        internalToggle = true;
        try {
            FluxDispatcher.dispatch({ type: "TOGGLE_GUILD_FOLDER_EXPAND", folderId });
        } finally {
            internalToggle = false;
        }
    };

    // Re-render collapsed folders by toggling them twice.
    function refreshFolders() {
        safe(() =>
            (getFolders() || [])
                .filter((f) => f.folderId && !isExpanded(f.folderId))
                .forEach(({ folderId }) => {
                    toggle(folderId);
                    toggle(folderId);
                }),
        );
    }

    // ── navigation to a guild (several fallbacks) ─────────────────────────
    function openGuild(guildId) {
        const tries = [
            ["transitionToGuild", () => metro.findByProps("transitionToGuild").transitionToGuild(guildId)],
            ["transitionToGuildSync", () => metro.findByProps("transitionToGuildSync").transitionToGuildSync(guildId)],
            ["transitionTo", () => metro.findByProps("transitionTo", "replaceWith").transitionTo(`/channels/${guildId}`)],
            ["deep link", () => Linking.openURL(`discord://-/channels/${guildId}`)],
        ];
        for (const [name, fn] of tries) {
            try {
                fn();
                status.nav = name;
                return true;
            } catch (e) {}
        }
        status.nav = "failed: no navigation method found";
        toast("BetterFolders: couldn't open that server");
        return false;
    }

    // ── tiny event emitter for the column state ───────────────────────────
    const listeners = new Set();
    let openFolderId = null;
    const setOpenFolder = (id) => {
        openFolderId = id;
        listeners.forEach((l) => safe(l));
    };
    const useOpenFolder = () => {
        const [, force] = React.useReducer((x) => x + 1, 0);
        React.useEffect(() => {
            listeners.add(force);
            return () => listeners.delete(force);
        }, []);
        return openFolderId;
    };

    // ── feature 1: tap handling (auto collapse / folder column) ───────────
    let warnedNoHost = false;
    function startFolderEvents() {
        if (!ExpandedStore) return (status.autoCollapse = status.column = "failed: ExpandedGuildFolderStore not found");
        if (!getFolders()) return (status.autoCollapse = status.column = "failed: folder list not found");

        const onToggle = ({ folderId: thisId }) => {
            if (internalToggle) return;
            // wait a tick so the store has applied this toggle
            setTimeout(() => {
                safe(() => {
                    if (storage.column && stats.hostMounted) {
                        // keep the folder closed in the main list, show its servers in the column instead
                        if (isExpanded(thisId)) toggle(thisId);
                        setOpenFolder(openFolderId === thisId ? null : thisId);
                        return;
                    }
                    if (storage.column && !warnedNoHost) {
                        warnedNoHost = true;
                        toast(`BetterFolders: column not ready, opening normally (gc ${status.hideIcons.startsWith("hooked") ? "found" : "missing"}, renders ${stats.renders}, attached ${stats.hostAttached})`);
                    }
                    if (!storage.autoCollapse || !isExpanded(thisId)) return;
                    (getFolders() || [])
                        .filter((f) => f.folderId && f.folderId !== thisId && isExpanded(f.folderId))
                        .forEach(({ folderId }) => toggle(folderId));
                });
            }, 0);
        };
        FluxDispatcher.subscribe("TOGGLE_GUILD_FOLDER_EXPAND", onToggle);
        unpatches.push(() => FluxDispatcher.unsubscribe("TOGGLE_GUILD_FOLDER_EXPAND", onToggle));
        status.autoCollapse = "ok";
    }

    // ── the column itself ─────────────────────────────────────────────────
    const iconUrl = (g) =>
        g && g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=96` : null;

    function GuildTile({ id, selected }) {
        const g = safe(() => GuildStore.getGuild(id), null);
        if (!g) return null;
        const url = iconUrl(g);
        const initials = (g.name || "?").split(/\s+/).map((w) => w[0]).join("").slice(0, 3);
        return h(
            Pressable,
            {
                onPress: () => {
                    setOpenFolder(null);
                    setTimeout(() => openGuild(id), 50);
                },
                style: { alignItems: "center", marginVertical: 5 },
            },
            h(View, {
                style: {
                    position: "absolute", left: -6, top: 12, width: 4, height: selected ? 24 : 0,
                    borderRadius: 2, backgroundColor: COLORS.text,
                },
            }),
            url
                ? h(Image, { source: { uri: url }, style: { width: 48, height: 48, borderRadius: selected ? 16 : 24 } })
                : h(
                      View,
                      {
                          style: {
                              width: 48, height: 48, borderRadius: selected ? 16 : 24,
                              backgroundColor: COLORS.tile, justifyContent: "center", alignItems: "center",
                          },
                      },
                      h(Text, { style: { color: COLORS.text, fontSize: 14, fontWeight: "600" } }, initials),
                  ),
        );
    }

    function FolderColumn() {
        const folderId = useOpenFolder();
        const folder = folderId != null ? getFolder(folderId) : null;
        if (!folder) return null;
        const selectedId = safe(() => SelectedGuildStore.getGuildId(), null);
        const left = typeof storage.columnLeft === "number" ? storage.columnLeft : barWidth;
        const tint = typeof folder.folderColor === "number" ? "#" + folder.folderColor.toString(16).padStart(6, "0") : COLORS.selected;

        return h(
            Modal,
            {
                transparent: true, visible: true, animationType: "fade",
                onRequestClose: () => setOpenFolder(null),
                supportedOrientations: ["portrait", "landscape"],
            },
            h(
                View,
                { style: { flex: 1, flexDirection: "row" } },
                // tap the server list area to close too
                h(Pressable, { style: { width: left }, onPress: () => setOpenFolder(null) }),
                h(
                    View,
                    {
                        style: {
                            width: 68, backgroundColor: COLORS.panel, paddingTop: 60, paddingBottom: 30,
                            borderLeftWidth: 1, borderRightWidth: 1, borderColor: COLORS.border,
                        },
                    },
                    h(Image, {
                        source: asset("img_guild_folder"),
                        style: { alignSelf: "center", width: 24, height: 24, tintColor: tint, marginBottom: 8 },
                    }),
                    h(View, { style: { height: 1, marginHorizontal: 16, marginBottom: 6, backgroundColor: COLORS.border } }),
                    h(
                        ScrollView,
                        { contentContainerStyle: { paddingVertical: 4 }, showsVerticalScrollIndicator: false },
                        (folder.guildIds || []).map((id) => h(GuildTile, { key: id, id, selected: id === selectedId })),
                    ),
                ),
                h(Pressable, { style: { flex: 1, backgroundColor: "#00000055" }, onPress: () => setOpenFolder(null) }),
            ),
        );
    }

    // Exactly one mounted host renders the column (it lives inside the server list).
    let ownerToken = null;
    const hostListeners = new Set();
    function ColumnHost() {
        const token = React.useRef({}).current;
        const [, force] = React.useReducer((x) => x + 1, 0);
        React.useEffect(() => {
            hostListeners.add(force);
            stats.hostMounted = true;
            if (!ownerToken) {
                ownerToken = token;
                force();
            }
            return () => {
                hostListeners.delete(force);
                if (ownerToken === token) {
                    ownerToken = null;
                    hostListeners.forEach((l) => safe(l));
                }
            };
        }, []);
        React.useEffect(() => {
            if (!ownerToken) ownerToken = token;
        });
        return ownerToken === token && storage.column ? h(FolderColumn) : null;
    }

    // ── feature 2: hook Discord's server bar (found by source file path) ──
    const PATHS = {
        bar: "modules/guilds_bar/native/GuildsBar.tsx",
        folder: "modules/guilds_bar/native/GuildsBarGuildFolder.tsx",
        consts: "modules/guilds_bar/native/GuildsBarConstants.tsx",
        guildIcon: "uikit-native/GuildIcon.tsx",
        pile: "design/components/Pile/native/GuildIconPile.native.tsx",
        guild: "modules/guilds_bar/native/GuildsBarGuild.tsx",
        pressable: "modules/guilds_bar/native/GuildsBarItemIconPressable.tsx",
    };
    const allMods = () => safe(() => vendetta.metro.modules || window.modules, {}) || {};
    function modByPath(path) {
        const mods = allMods();
        // fast path: id remembered from a previous run
        const known = storage.ids && storage.ids[path];
        if (known != null && mods[known] && mods[known].__filePath === path)
            return safe(() => mods[known].publicModule.exports, null);
        for (const id in mods) {
            const m = mods[id];
            if (m && m.__filePath === path) {
                if (!storage.ids) storage.ids = {};
                storage.ids[path] = Number(id);
                return safe(() => m.publicModule.exports, null);
            }
        }
        return null;
    }

    // Load remembered modules early so we can patch them before Discord first draws the server bar.
    function preloadKnownModules() {
        if (!storage.ids) return 0;
        let n = 0;
        for (const path in storage.ids) {
            const id = storage.ids[path];
            const m = allMods()[id];
            if (!m) continue;
            if (!m.isInitialized) safe(() => (window.__r ? window.__r(id) : null));
            if (allMods()[id] && allMods()[id].__filePath === path) n++;
        }
        return n;
    }

    // patch a component whatever its wrapper is (memo / forwardRef / plain fn)
    function patchComponent(comp, cb) {
        if (!comp) return null;
        if (comp.type && typeof comp.type.render === "function") return patcher.after("render", comp.type, cb);
        if (typeof comp.render === "function") return patcher.after("render", comp, cb);
        if (typeof comp.type === "function") return patcher.after("type", comp, cb);
        return null;
    }

    const folderIcon = (tint) =>
        h(
            View,
            { style: { overflow: "hidden", borderRadius: 16, height: 48, width: 48, justifyContent: "center", alignItems: "center" } },
            h(Image, { source: asset("img_guild_folder"), style: tint ? { tintColor: tint } : {} }),
        );
    const pick = (...vals) => {
        for (const v of vals) if (v !== undefined && v !== null) return v;
        return undefined;
    };
    const toHex = (n) => (typeof n === "number" ? "#" + n.toString(16).padStart(6, "0") : n);

    const known = new Map(); // component -> label, for readable diagnostics
    const labelOf = (t) => {
        if (typeof t === "string") return t;
        if (!t) return String(t);
        if (known.has(t)) return known.get(t);
        return t.displayName || t.name || (t.type && (t.type.displayName || t.type.name)) || (t.render && t.render.name) || (t.$$typeof ? "memo/fwd" : typeof t);
    };
    function outline(node, depth = 0, out = []) {
        if (out.length > 60 || depth > 6 || node == null || typeof node !== "object") return out;
        if (Array.isArray(node)) {
            node.forEach((n) => outline(n, depth, out));
            return out;
        }
        if (!node.props) return out;
        const keys = Object.keys(node.props).filter((k) => k !== "children").slice(0, 8).join(",");
        out.push(`${"  ".repeat(depth)}${labelOf(node.type)} {${keys}}`);
        outline(node.props.children, depth + 1, out);
        return out;
    }
    const diag = { folderProps: "", folderTree: "", barTree: "", hideResult: "not tried" };

    // replace the first element whose subtree holds 2+ guild icons with a folder icon
    function hideInTree(root, tint, iconTypes) {
        let replaced = false;
        const count = (n) => {
            if (n == null || typeof n !== "object") return 0;
            if (Array.isArray(n)) return n.reduce((a, c) => a + count(c), 0);
            if (!n.props) return 0;
            return (iconTypes.has(n.type) ? 1 : 0) + count(n.props.children);
        };
        const walk = (n, parent, key) => {
            if (replaced || n == null || typeof n !== "object") return;
            if (Array.isArray(n)) return n.forEach((c, i) => walk(c, n, i));
            if (!n.props) return;
            if (n.type && iconTypes.has(n.type) && n.type === iconTypes.pile) {
                parent[key] = folderIcon(tint);
                replaced = true;
                return;
            }
            const kids = n.props.children;
            if (count(kids) >= 2 && !(Array.isArray(kids) ? kids : [kids]).some((k) => count(k) >= 2)) {
                n.props.children = folderIcon(tint);
                replaced = true;
                return;
            }
            if (Array.isArray(kids)) kids.forEach((c, i) => walk(c, kids, i));
            else if (kids && typeof kids === "object") walk(kids, n.props, "children");
        };
        walk(root, { root }, "root");
        return replaced;
    }

    function startGuildContainerPatch() {
        const barMod = modByPath(PATHS.bar);
        if (!barMod || !barMod.default) {
            status.hideIcons = status.column = "waiting: server bar not loaded yet";
            return false;
        }

        // readable names for diagnostics + icon detection
        const gi = safe(() => modByPath(PATHS.guildIcon).default);
        const pile = safe(() => modByPath(PATHS.pile).GuildIconPile);
        const gg = safe(() => modByPath(PATHS.guild).default);
        const pr = safe(() => modByPath(PATHS.pressable).default);
        const folderMod = modByPath(PATHS.folder);
        [[gi, "GuildIcon"], [pile, "GuildIconPile"], [gg, "GuildsBarGuild"], [pr, "ItemIconPressable"],
         [barMod.default, "GuildsBar"], [folderMod && folderMod.default, "GuildsBarGuildFolder"],
         [folderMod && folderMod.GuildsBarGuildFolderBG, "GuildFolderBG"]].forEach(([c, n]) => c && known.set(c, n));
        const iconTypes = new Set([gi, pile, gg].filter(Boolean));
        iconTypes.pile = pile;

        const width = safe(() => modByPath(PATHS.consts).GUILD_LIST_WIDTH);
        if (typeof width === "number") barWidth = width;

        // 1) mount the column host next to the server bar
        const unBar = patchComponent(barMod.default, (args, res) => {
            stats.renders++;
            if (!diag.barTree) diag.barTree = outline(res).slice(0, 12).join("\n");
            if (!res) return res;
            stats.hostAttached++;
            stats.attachMode = "GuildsBar";
            return h(React.Fragment, null, res, h(ColumnHost, { key: "bf-column-host" }));
        });
        if (unBar) unpatches.push(unBar);
        status.column = unBar ? (status.autoCollapse === "ok" ? "ok (GuildsBar hooked)" : status.autoCollapse) : "failed: couldn't patch GuildsBar";

        // 2) hide icons in collapsed folders
        const unFolder = folderMod && folderMod.default
            ? patchComponent(folderMod.default, ([props], res) => {
                  safe(() => {
                      if (!diag.folderProps) diag.folderProps = Object.keys(props || {}).join(",");
                      if (!diag.folderTree) diag.folderTree = outline(res).join("\n");
                      if (!storage.hideIcons || !res) return;
                      const fid = pick(safe(() => props.folderNode.id), safe(() => props.folder.folderId), safe(() => props.folderId), safe(() => props.node.id));
                      const expanded = pick(props.expanded, props.isExpanded, fid != null ? isExpanded(fid) : false);
                      if (expanded) return;
                      const folder = fid != null ? getFolder(fid) : null;
                      const color = toHex(pick(folder ? folder.folderColor : undefined, safe(() => props.folderNode.color), safe(() => props.folderColor)));
                      const ok = hideInTree(res, color, iconTypes);
                      diag.hideResult = ok ? "replaced" : "no icon group in output";
                      if (ok) stats.previewPatched++;
                  });
                  return res;
              })
            : null;
        if (unFolder) unpatches.push(unFolder);
        status.hideIcons = unFolder ? "hooked (GuildsBarGuildFolder)" : "failed: folder component not found";
        return true;
    }
    let barWidth = 64;

    let retryTimer = null;
    let stopped = false;
    function patchWhenReady() {
        let tries = 0;
        const attempt = () => {
            if (stopped) return;
            tries++;
            if (safe(startGuildContainerPatch, false)) {
                setTimeout(refreshFolders, 200);
                if (tries > 1) toast(`BetterFolders ${VERSION} | hooked after ${tries}s | column: ${status.column}`);
                return;
            }
            if (tries >= 120) {
                status.hideIcons = "failed: GuildContainer not found after 2 min";
                status.column = "failed: nowhere to mount (GuildContainer not found)";
                toast(`BetterFolders: ${status.column}`);
                return;
            }
            retryTimer = setTimeout(attempt, 1000);
        };
        attempt();
    }

    // ── scanner: list Discord modules related to guild folders ────────────
    function scanDiscord() {
        const mods = safe(() => vendetta.metro.modules || window.modules, {}) || {};
        const out = [];
        let total = 0, withPath = 0;
        const RX = /folder|guilds?_?bar|guild_?list|guilds?nav|guildsidebar|server_?list|guild_?item|guildicon/i;
        for (const id in mods) {
            total++;
            const m = mods[id];
            const path = m && m.__filePath;
            if (!path) continue;
            withPath++;
            if (!RX.test(path)) continue;
            const exp = safe(() => m.publicModule && m.publicModule.exports);
            let desc = "";
            safe(() => {
                if (!exp) return (desc = "no exports");
                const keys = Object.keys(exp).slice(0, 12);
                desc = keys
                    .map((k) => {
                        const v = exp[k];
                        const t = typeof v === "function" ? "fn" : v && typeof v === "object" ? (v.$$typeof ? "memo/fwd" : "obj") : typeof v;
                        return `${k}:${t}`;
                    })
                    .join(",");
            });
            out.push(`${id} ${path} [${desc}]`);
        }
        out.unshift(`--- preloaded ${stats.preloaded || 0} · bar renders ${stats.renders} · ids ${JSON.stringify(storage.ids || {})}`, `--- folder props: ${diag.folderProps}`, `--- hide result: ${diag.hideResult} · bar width ${barWidth}`, `--- folder tree:\n${diag.folderTree}`, `--- bar tree:\n${diag.barTree}`, `--- paths:`);
        return `BetterFolders ${VERSION} scan: ${out.length} matches (${withPath}/${total} modules have paths)\n` + (out.slice(0, 120).join("\n") || "nothing found");
    }

    // ── settings page (plain React Native, no internal helpers) ───────────
    function Row({ label, sub, value, onChange }) {
        return h(
            Pressable,
            {
                onPress: () => onChange(!value),
                style: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 14 },
            },
            h(
                View,
                { style: { flex: 1, paddingRight: 12 } },
                h(Text, { style: { color: COLORS.text, fontSize: 16, fontWeight: "600" } }, label),
                h(Text, { style: { color: COLORS.sub, fontSize: 13, marginTop: 2 } }, sub),
            ),
            h(Switch, { value, onValueChange: onChange }),
        );
    }

    function Stepper({ label, value, onChange }) {
        const btn = (t, d) =>
            h(
                Pressable,
                {
                    onPress: () => onChange(value + d),
                    style: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 8, backgroundColor: COLORS.tile, marginLeft: 8 },
                },
                h(Text, { style: { color: COLORS.text, fontSize: 16 } }, t),
            );
        return h(
            View,
            { style: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 10 } },
            h(Text, { style: { flex: 1, color: COLORS.text, fontSize: 15 } }, `${label}: ${value}`),
            btn("−", -4),
            btn("+", 4),
        );
    }

    function Settings() {
        const [, force] = React.useReducer((x) => x + 1, 0);
        const [scan, setScan] = React.useState(null);
        const runScan = () => {
            const out = safe(scanDiscord, "scan failed");
            setScan(out);
            const ok = safe(() => {
                metro.common.clipboard.setString(out);
                return true;
            }, false);
            toast(ok ? "Scan copied to clipboard - paste it to Claude" : "Scan done - screenshot the list");
        };
        const set = (key) => (v) => {
            storage[key] = v;
            if (key === "hideIcons") setTimeout(refreshFolders, 100);
            if (key === "column" && !v) setOpenFolder(null);
            force();
        };
        const line = (t) => h(Text, { style: { color: COLORS.sub, fontSize: 12, paddingHorizontal: 16, marginTop: 4 } }, t);

        return h(
            ScrollView,
            { style: { flex: 1, paddingTop: 10 } },
            h(Row, {
                label: "Folder column",
                sub: "Open folders in a separate column next to the server list (like Vencord).",
                value: !!storage.column,
                onChange: set("column"),
            }),
            storage.column
                ? h(Stepper, {
                      label: "Column position",
                      value: typeof storage.columnLeft === "number" ? storage.columnLeft : barWidth,
                      onChange: (v) => set("columnLeft")(Math.max(0, Math.min(200, v))),
                  })
                : null,
            h(Row, {
                label: "Auto collapse",
                sub: "Close other folders when you open one (when the column is off).",
                value: !!storage.autoCollapse,
                onChange: set("autoCollapse"),
            }),
            h(Row, {
                label: "Hide icons",
                sub: "Show a plain folder icon instead of server icons in collapsed folders.",
                value: !!storage.hideIcons,
                onChange: set("hideIcons"),
            }),
            h(View, { style: { height: 16 } }),
            line(`BetterFolders ${VERSION} diagnostics`),
            line(`Folder column: ${status.column}`),
            line(`Open server via: ${status.nav}`),
            line(`Auto collapse: ${status.autoCollapse}`),
            line(`Hide icons: ${status.hideIcons}`),
            line(`preloaded ${stats.preloaded || 0} · renders ${stats.renders} · preview ${stats.previewPatched} · attached ${stats.hostAttached} (${stats.attachMode}) · host ${stats.hostMounted ? "mounted" : "not mounted"}`),
            h(
                Pressable,
                {
                    onPress: runScan,
                    style: { margin: 16, padding: 14, borderRadius: 12, backgroundColor: COLORS.selected, alignItems: "center" },
                },
                h(Text, { style: { color: "#FFFFFF", fontSize: 16, fontWeight: "700" } }, "Scan Discord (copies result)"),
            ),
            scan ? h(Text, { selectable: true, style: { color: COLORS.sub, fontSize: 11, paddingHorizontal: 16, paddingBottom: 40, fontFamily: "Menlo" } }, scan) : null,
        );
    }

    return {
        onLoad() {
            if (storage.hideIcons === undefined) storage.hideIcons = true;
            if (storage.autoCollapse === undefined) storage.autoCollapse = true;
            if (storage.column === undefined) storage.column = true;
            safe(startFolderEvents);
            stopped = false;
            stats.preloaded = safe(preloadKnownModules, 0);
            patchWhenReady();
            // if the bar was already on screen when we hooked it, React keeps the old version until a reload
            setTimeout(() => {
                if (!stopped && stats.renders === 0 && status.column.startsWith("ok"))
                    toast("BetterFolders: reload Discord once to finish setup (Settings → Kettu → Reload Discord)");
            }, 4000);
            if (status.autoCollapse !== "ok") status.column = status.autoCollapse;
            setTimeout(() => {
                // start with every folder closed so the column is the only way folders open
                if (storage.column)
                    safe(() => (getFolders() || []).forEach((f) => f.folderId && isExpanded(f.folderId) && toggle(f.folderId)));
                refreshFolders();
            }, 300);
            const msg = `BetterFolders ${VERSION} | column: ${status.column} | icons: ${status.hideIcons}`;
            safe(() => logger.log(msg));
            toast(msg);
        },
        onUnload() {
            stopped = true;
            if (retryTimer) clearTimeout(retryTimer);
            setOpenFolder(null);
            unpatches.splice(0).forEach((u) => safe(u));
            setTimeout(refreshFolders, 100);
        },
        settings: Settings,
    };
})()
