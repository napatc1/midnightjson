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

    const VERSION = "1.1.2";
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
        const left = typeof storage.columnLeft === "number" ? storage.columnLeft : 64;
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

    // ── feature 2: GuildContainer patch (hide icons + mount the column host) ──
    const folderIcon = (tint) =>
        h(
            View,
            {
                style: {
                    overflow: "hidden", borderRadius: 16, height: 48, width: 48,
                    justifyContent: "center", alignItems: "center",
                },
            },
            h(Image, { source: asset("img_guild_folder"), style: tint ? { tintColor: tint } : {} }),
        );

    const toHex = (n) => (typeof n === "number" ? "#" + n.toString(16).padStart(6, "0") : n);

    function startGuildContainerPatch() {
        const mods = safe(() => metro.findByPropsAll("GuildContainer"), []);
        const mod = mods && mods.length ? mods[mods.length - 1] : null;
        if (!mod) {
            status.hideIcons = "waiting: GuildContainer not loaded yet";
            status.column = "waiting: GuildContainer not loaded yet";
            return false;
        }

        const un = patcher.after("GuildContainer", mod, ([props], res) => {
            stats.renders++;
            safe(() => {
                if (!storage.hideIcons || !props || props.expanded) return;
                const Preview = props.children && props.children.type;

                if (Preview && Preview.type) {
                    const once = patcher.after("type", Preview, ([fp], g) => {
                        once();
                        stats.previewPatched++;
                        safe(() => {
                            if (props.expanded || !g || !g.props || !Array.isArray(g.props.children)) return;
                            g.props.children[1] = folderIcon(toHex(fp && fp.folderColor));
                        });
                    });
                    return;
                }

                // older/alternate layout
                const p = props.children && props.children.props;
                if (!p || !Array.isArray(p.children) || !p.children[1]) return;
                const color = safe(() => {
                    const st = p.children[0].props.style;
                    return (Array.isArray(st) ? st.find((s) => s && s.backgroundColor) : st).backgroundColor;
                });
                p.children[1] = folderIcon(color);
            });

            safe(() => {
                if (!res || !res.props || stats.hostAttached > 40) return;
                const host = h(ColumnHost, { key: "bf-column-host" });
                const ch = res.props.children;
                if (Array.isArray(ch)) {
                    if (!ch.some((c) => c && c.key === "bf-column-host")) res.props.children = [...ch, host];
                } else if (ch !== undefined) {
                    res.props.children = [ch, host];
                } else {
                    return;
                }
                stats.hostAttached++;
                stats.attachMode = Array.isArray(ch) ? "array" : typeof ch;
            });
            return res;
        });
        unpatches.push(un);
        status.hideIcons = "hooked (GuildContainer found)";
        if (status.autoCollapse === "ok") status.column = "ok";
        return true;
    }

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
                      value: typeof storage.columnLeft === "number" ? storage.columnLeft : 64,
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
            line(`renders ${stats.renders} · preview ${stats.previewPatched} · attached ${stats.hostAttached} (${stats.attachMode}) · host ${stats.hostMounted ? "mounted" : "not mounted"}`),
        );
    }

    return {
        onLoad() {
            if (storage.hideIcons === undefined) storage.hideIcons = true;
            if (storage.autoCollapse === undefined) storage.autoCollapse = true;
            if (storage.column === undefined) storage.column = true;
            safe(startFolderEvents);
            stopped = false;
            patchWhenReady();
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
