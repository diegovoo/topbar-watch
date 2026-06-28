import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const CONFIG_FILE = 'status-items.json';
const CONFIG_DIR = 'topbar-watch';
const RELOAD_DELAY_MS = 100;
const DEFAULT_SEPARATOR_STYLE = 'pipe';
const DEFAULT_SPACING = 'balanced';
const DEFAULT_LEADING_SEPARATOR = false;
const DEFAULT_TRAILING_SEPARATOR = false;

const SEPARATOR_STYLES = {
    none: '',
    dot: '·',
    pipe: '|',
    slash: '/',
    bullet: '•',
};

const SPACING_PRESETS = {
    compact: 4,
    balanced: 8,
    roomy: 14,
};

export default class TopbarWatchExtension extends Extension {
    enable() {
        this._enabled = true;
        this._configMonitor = null;
        this._statusMonitors = [];
        this._reloadSourceIds = new Map();
        this._items = new Map();
        this._reloadConfigSerial = 0;
        this._appearance = {
            separatorStyle: DEFAULT_SEPARATOR_STYLE,
            spacing: DEFAULT_SPACING,
            leadingSeparator: DEFAULT_LEADING_SEPARATOR,
            trailingSeparator: DEFAULT_TRAILING_SEPARATOR,
        };
        this._runtimeDir = GLib.getenv('XDG_RUNTIME_DIR') || GLib.get_user_runtime_dir();
        this._defaultConfigPath = this._getExtensionFilePath(CONFIG_FILE);
        this._configPath = this._getUserConfigPath();

        this._indicator = new PanelMenu.Button(0.0, this.metadata.name, false);
        this._indicator.set_style('padding-left: 0px; padding-right: 0px;');
        const preferencesItem =
            new PopupMenu.PopupImageMenuItem('Preferences', 'emblem-system-symbolic');
        preferencesItem.connect('activate', () => this.openPreferences());
        this._indicator.menu.addMenuItem(preferencesItem);

        this._box = new St.BoxLayout({
            style_class: 'panel-status-menu-box',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._indicator.add_child(this._box);

        Main.panel.addToStatusArea(this.uuid, this._indicator, 2, 'left');

        this._watchConfig();
        this._reloadStatusItems();
    }

    disable() {
        this._enabled = false;
        this._reloadConfigSerial++;

        if (this._reloadSourceIds) {
            for (const sourceId of this._reloadSourceIds.values())
                GLib.source_remove(sourceId);

            this._reloadSourceIds.clear();
        }

        this._clearMonitor(this._configMonitor);
        this._configMonitor = null;
        this._clearStatusItems();

        this._box?.destroy();
        this._box = null;

        this._indicator?.destroy();
        this._indicator = null;

        this._items?.clear();
        this._items = null;
        this._statusMonitors = null;
        this._reloadSourceIds = null;
        this._appearance = null;
        this._runtimeDir = null;
        this._defaultConfigPath = null;
        this._configPath = null;
    }

    _watchConfig() {
        this._configMonitor = this._watchFile(
            this._configPath,
            () => this._reloadStatusItems()
        );
    }

    _reloadStatusItems() {
        const serial = ++this._reloadConfigSerial;

        this._clearStatusItems();

        this._loadConfigAsync().then(config => {
            if (!this._enabled || serial !== this._reloadConfigSerial || !this._box)
                return;

            this._appearance = {
                separatorStyle: config.separatorStyle,
                spacing: config.spacing,
                leadingSeparator: config.leadingSeparator,
                trailingSeparator: config.trailingSeparator,
            };

            for (const definition of config.items)
                this._addStatusItem(definition);
        });
    }

    _addStatusItem(definition) {
        const path = this._expandPath(definition.path);
        const container = new St.BoxLayout({
            y_align: Clutter.ActorAlign.CENTER,
            style: this._buildItemStyle(false),
        });
        const separator = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const separatorSpacer = new St.Widget({
            style: this._buildSpacerStyle(false),
        });
        const label = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'max-width: 260px;',
        });
        label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        const trailingSeparatorSpacer = new St.Widget({
            style: this._buildSpacerStyle(false),
        });
        const trailingSeparator = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
        });

        container.add_child(separator);
        container.add_child(separatorSpacer);
        container.add_child(label);
        container.add_child(trailingSeparatorSpacer);
        container.add_child(trailingSeparator);

        this._items.set(definition.id, {
            path,
            container,
            separator,
            separatorSpacer,
            trailingSeparatorSpacer,
            trailingSeparator,
            label,
            reloadSerial: 0,
        });

        this._box.add_child(container);

        const monitor = this._watchFile(
            path,
            () => this._reloadStatusItem(definition.id)
        );

        if (monitor)
            this._statusMonitors.push(monitor);

        this._reloadStatusItem(definition.id);
    }

    _clearStatusItems() {
        if (this._reloadSourceIds) {
            for (const sourceId of this._reloadSourceIds.values())
                GLib.source_remove(sourceId);

            this._reloadSourceIds.clear();
        }

        if (this._statusMonitors) {
            for (const monitor of this._statusMonitors)
                this._clearMonitor(monitor);

            this._statusMonitors = [];
        }

        if (this._items) {
            for (const item of this._items.values())
                item.container.destroy();

            this._items.clear();
        }
    }

    _reloadStatusItem(id) {
        const item = this._items?.get(id);

        if (!item)
            return;

        const path = item.path;
        const serial = item.reloadSerial + 1;
        item.reloadSerial = serial;

        this._readFileAsync(path).then(text => {
            const currentItem = this._items?.get(id);

            if (!this._enabled || !currentItem)
                return;

            if (currentItem.path !== path || currentItem.reloadSerial !== serial)
                return;

            const displayText = text || '';

            currentItem.label.set_text(displayText);
            currentItem.container.visible = displayText.length > 0;
            this._updateVisibleItemSpacing();
        });
    }

    _updateVisibleItemSpacing() {
        const visibleItems = Array.from(this._items.values())
            .filter(item => item.container.visible);

        visibleItems.forEach((item, index) => {
            const isFirstVisibleItem = index === 0;
            const isLastVisibleItem = index === visibleItems.length - 1;
            const hasPreviousVisibleItem = !isFirstVisibleItem;
            const hasLeadingSeparator =
                this._appearance.leadingSeparator || hasPreviousVisibleItem;
            const hasTrailingSeparator =
                this._appearance.trailingSeparator && isLastVisibleItem;

            item.separator.text = hasLeadingSeparator ? this._getSeparatorText() : '';
            item.trailingSeparator.text = hasTrailingSeparator ? this._getSeparatorText() : '';
            item.container.set_style(this._buildItemStyle(hasPreviousVisibleItem));
            item.separatorSpacer.set_style(this._buildSpacerStyle(hasLeadingSeparator));
            item.trailingSeparatorSpacer.set_style(this._buildSpacerStyle(hasTrailingSeparator));
        });
    }

    _watchFile(path, reloadCallback) {
        const dir = GLib.path_get_dirname(path);

        try {
            GLib.mkdir_with_parents(dir, 0o700);
        } catch {
            return null;
        }

        const dirFile = Gio.File.new_for_path(dir);

        let monitor;

        try {
            monitor = dirFile.monitor_directory(Gio.FileMonitorFlags.NONE, null);
        } catch {
            return null;
        }

        const handlerId = monitor.connect(
            'changed',
            (_monitor, file, otherFile, _eventType) => {
                const changedPath = file ? file.get_path() : null;
                const otherPath = otherFile ? otherFile.get_path() : null;

                if (changedPath === path || otherPath === path)
                    this._scheduleReload(path, reloadCallback);
            }
        );

        return {
            monitor,
            handlerId,
        };
    }

    _clearMonitor(item) {
        if (!item)
            return;

        if (item.monitor && item.handlerId)
            item.monitor.disconnect(item.handlerId);

        item.monitor?.cancel();
    }

    _scheduleReload(key, reloadCallback) {
        if (!this._reloadSourceIds || this._reloadSourceIds.has(key))
            return;

        const sourceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            RELOAD_DELAY_MS,
            () => {
                this._reloadSourceIds?.delete(key);

                if (!this._enabled)
                    return GLib.SOURCE_REMOVE;

                reloadCallback();
                return GLib.SOURCE_REMOVE;
            }
        );

        this._reloadSourceIds.set(key, sourceId);
    }

    _readFileAsync(path) {
        return new Promise(resolve => {
            const file = Gio.File.new_for_path(path);

            file.load_contents_async(null, (source, result) => {
                try {
                    const [ok, contents] = source.load_contents_finish(result);

                    if (!ok) {
                        resolve(null);
                        return;
                    }

                    resolve(new TextDecoder().decode(contents).trim());
                } catch {
                    resolve(null);
                }
            });
        });
    }

    async _loadConfigAsync() {
        let contents = await this._readFileAsync(this._configPath);

        if (contents === null)
            contents = await this._readFileAsync(this._defaultConfigPath);

        if (!contents)
            return this._createDefaultConfig();

        try {
            const config = JSON.parse(contents);

            if (!config || typeof config !== 'object' || Array.isArray(config))
                return this._createDefaultConfig();

            if (!Array.isArray(config.items))
                return this._createDefaultConfig();

            return {
                separatorStyle: this._isKnownSeparatorStyle(config.separatorStyle)
                    ? config.separatorStyle
                    : DEFAULT_SEPARATOR_STYLE,
                spacing: this._isKnownSpacing(config.spacing)
                    ? config.spacing
                    : DEFAULT_SPACING,
                leadingSeparator: typeof config.leadingSeparator === 'boolean'
                    ? config.leadingSeparator
                    : DEFAULT_LEADING_SEPARATOR,
                trailingSeparator: typeof config.trailingSeparator === 'boolean'
                    ? config.trailingSeparator
                    : DEFAULT_TRAILING_SEPARATOR,
                items: config.items.filter(item => this._isValidStatusItem(item)),
            };
        } catch {
            return this._createDefaultConfig();
        }
    }

    _isValidStatusItem(item) {
        if (!item || typeof item !== 'object')
            return false;

        if (typeof item.id !== 'string' || item.id.length === 0)
            return false;

        if (typeof item.path !== 'string' || item.path.length === 0)
            return false;

        return true;
    }

    _buildItemStyle(hasPreviousVisibleItem) {
        if (!hasPreviousVisibleItem)
            return 'margin-left: 0px;';

        return `margin-left: ${SPACING_PRESETS[this._appearance.spacing]}px;`;
    }

    _buildSpacerStyle(visible) {
        const width = visible ? SPACING_PRESETS[this._appearance.spacing] : 0;
        return `width: ${width}px;`;
    }

    _getSeparatorText() {
        return SEPARATOR_STYLES[this._appearance.separatorStyle];
    }

    _createDefaultConfig() {
        return {
            separatorStyle: DEFAULT_SEPARATOR_STYLE,
            spacing: DEFAULT_SPACING,
            leadingSeparator: DEFAULT_LEADING_SEPARATOR,
            trailingSeparator: DEFAULT_TRAILING_SEPARATOR,
            items: [],
        };
    }

    _isKnownSeparatorStyle(value) {
        return Object.hasOwn(SEPARATOR_STYLES, value);
    }

    _isKnownSpacing(value) {
        return Object.hasOwn(SPACING_PRESETS, value);
    }

    _expandPath(path) {
        let expanded = path
            .replaceAll('$XDG_RUNTIME_DIR', this._runtimeDir)
            .replaceAll('${XDG_RUNTIME_DIR}', this._runtimeDir)
            .replaceAll('$HOME', GLib.get_home_dir())
            .replaceAll('${HOME}', GLib.get_home_dir());

        if (expanded.startsWith('~/'))
            expanded = GLib.build_filenamev([GLib.get_home_dir(), expanded.slice(2)]);

        return expanded;
    }

    _getExtensionFilePath(filename) {
        if (this.dir)
            return this.dir.get_child(filename).get_path();

        return GLib.build_filenamev([this.path, filename]);
    }

    _getUserConfigPath() {
        return GLib.build_filenamev([
            GLib.get_user_config_dir(),
            CONFIG_DIR,
            CONFIG_FILE,
        ]);
    }
}
