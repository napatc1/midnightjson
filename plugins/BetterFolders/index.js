(() => {
    "use strict";
    // BetterFolders, rebuilt for Kettu. Original idea and code by fres (fres621/vendetta-plugins).
    // Every lookup is guarded so a missing Discord internal disables one feature
    // instead of crashing the whole plugin.

    const { metro, patcher, plugin, logger } = vendetta;
    const { storage } = plugin;
    const { React, ReactNative, FluxDispatcher } = metro.common;
    const { View, Text, Image, ScrollView, Switch, Pressable } = ReactNative;

    const VERSION = "1.0.0";
    const status = { autoCollapse: "not started", hideIcons: "not started" };
    const unpatches = [];

    const safe = (fn, fallback) => {
        try {
            const r = fn();
            return r === undefined ? fallback : r;
        } catch (e) {
            return fallback;
        }
    };

    const toast = (msg) =>
        safe(() => {
            const icon = safe(() => vendetta.ui.assets.getAssetIDByName("img_guild_folder"));
            vendetta.ui.toasts.showToast(msg, icon);
        });

    // ── store lookups (with fallbacks for renamed stores) ─────────────────
    const ExpandedStore = safe(() => metro.findByStoreName("ExpandedGuildFolderStore"));
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

    const isExpanded = (id) => !!safe(() => ExpandedStore.isFolderExpanded(id), false);
    const toggle = (folderId) => FluxDispatcher.dispatch({ type: "TOGGLE_GUILD_FOLDER_EXPAND", folderId });

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

    // ── feature 1: auto collapse ──────────────────────────────────────────
    function startAutoCollapse() {
        if (!ExpandedStore) return (status.autoCollapse = "failed: ExpandedGuildFolderStore not found");
        if (!getFolders()) return (status.autoCollapse = "failed: folder list not found");

        let busy = false;
        const onToggle = ({ folderId: thisId }) => {
            if (busy || !storage.autoCollapse) return;
            // wait a tick so the store has applied this toggle
            setTimeout(() => {
                if (!isExpanded(thisId)) return;
                busy = true;
                safe(() =>
                    (getFolders() || [])
                        .filter((f) => f.folderId && f.folderId !== thisId && isExpanded(f.folderId))
                        .forEach(({ folderId }) => toggle(folderId)),
                );
                busy = false;
            }, 0);
        };
        FluxDispatcher.subscribe("TOGGLE_GUILD_FOLDER_EXPAND", onToggle);
        unpatches.push(() => FluxDispatcher.unsubscribe("TOGGLE_GUILD_FOLDER_EXPAND", onToggle));
        status.autoCollapse = "ok";
    }

    // ── feature 2: hide server icons in collapsed folders ─────────────────
    const folderIcon = (tint) =>
        React.createElement(
            View,
            {
                style: {
                    overflow: "hidden", borderRadius: 16, height: 48, width: 48,
                    justifyContent: "center", alignItems: "center",
                },
            },
            React.createElement(Image, {
                source: safe(() => vendetta.ui.assets.getAssetIDByName("img_guild_folder")),
                style: tint ? { tintColor: tint } : {},
            }),
        );

    const toHex = (n) => (typeof n === "number" ? "#" + n.toString(16).padStart(6, "0") : n);

    function startHideIcons() {
        const mods = safe(() => metro.findByPropsAll("GuildContainer"), []);
        const mod = mods && mods.length ? mods[mods.length - 1] : null;
        if (!mod) return (status.hideIcons = "failed: GuildContainer not found");

        const un = patcher.after("GuildContainer", mod, ([props], res) => {
            safe(() => {
                if (!storage.hideIcons || !props || props.expanded) return;
                const Preview = props.children && props.children.type;

                if (Preview && Preview.type) {
                    const once = patcher.after("type", Preview, ([fp], g) => {
                        once();
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
            return res;
        });
        unpatches.push(un);
        status.hideIcons = "hooked (GuildContainer found)";
    }

    // ── settings page (plain React Native, no internal helpers) ───────────
    function Row({ label, sub, value, onChange }) {
        return React.createElement(
            Pressable,
            {
                onPress: () => onChange(!value),
                style: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 14 },
            },
            React.createElement(
                View,
                { style: { flex: 1, paddingRight: 12 } },
                React.createElement(Text, { style: { color: "#E6EAF5", fontSize: 16, fontWeight: "600" } }, label),
                React.createElement(Text, { style: { color: "#8A93AD", fontSize: 13, marginTop: 2 } }, sub),
            ),
            React.createElement(Switch, { value, onValueChange: onChange }),
        );
    }

    function Settings() {
        const [, force] = React.useReducer((x) => x + 1, 0);
        const set = (key) => (v) => {
            storage[key] = v;
            if (key === "hideIcons") setTimeout(refreshFolders, 100);
            force();
        };
        const line = (t) =>
            React.createElement(Text, { style: { color: "#8A93AD", fontSize: 12, paddingHorizontal: 16, marginTop: 4 } }, t);

        return React.createElement(
            ScrollView,
            { style: { flex: 1, paddingTop: 10 } },
            React.createElement(Row, {
                label: "Auto collapse",
                sub: "Close other folders when you open one.",
                value: !!storage.autoCollapse,
                onChange: set("autoCollapse"),
            }),
            React.createElement(Row, {
                label: "Hide icons",
                sub: "Show a plain folder icon instead of server icons in collapsed folders.",
                value: !!storage.hideIcons,
                onChange: set("hideIcons"),
            }),
            React.createElement(View, { style: { height: 16 } }),
            line(`BetterFolders ${VERSION} diagnostics`),
            line(`Auto collapse: ${status.autoCollapse}`),
            line(`Hide icons: ${status.hideIcons}`),
        );
    }

    return {
        onLoad() {
            if (storage.hideIcons === undefined) storage.hideIcons = true;
            if (storage.autoCollapse === undefined) storage.autoCollapse = true;
            safe(startAutoCollapse);
            safe(startHideIcons);
            setTimeout(refreshFolders, 300);
            const msg = `BetterFolders ${VERSION} | collapse: ${status.autoCollapse} | icons: ${status.hideIcons}`;
            safe(() => logger.log(msg));
            toast(msg);
        },
        onUnload() {
            unpatches.splice(0).forEach((u) => safe(u));
            setTimeout(refreshFolders, 100);
        },
        settings: Settings,
    };
})()
