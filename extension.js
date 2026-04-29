import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

const CONFIG_FILE = 'status-items.json';
const CONFIG_DIR = 'topbar-watch';
const RELOAD_DELAY_MS = 100;
const DEFAULT_MARGIN_LEFT_PX = 8;
const DEFAULT_MARGIN_RIGHT_PX = 12;
const DEFAULT_SEPARATOR = '|';

export default class TopbarWatchExtension extends Extension {
    enable() {
        this._configMonitor = null;
        this._statusMonitors = [];
        this._reloadSourceIds = new Map();
        this._items = new Map();
        this._runtimeDir = GLib.getenv('XDG_RUNTIME_DIR') || GLib.get_user_runtime_dir();
        this._defaultConfigPath = this._getExtensionFilePath(CONFIG_FILE);
        this._configPath = this._getUserConfigPath();

        this._indicator = new PanelMenu.Button(0.0, this.metadata.name, false);
        this._indicator.set_style('padding-left: 0px; padding-right: 0px;');
        this._indicator.connect('button-press-event', () => {
            this.openPreferences();
            return Clutter.EVENT_STOP;
        });

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
        for (const sourceId of this._reloadSourceIds.values())
            GLib.source_remove(sourceId);

        this._reloadSourceIds.clear();

        this._clearMonitor(this._configMonitor);
        this._configMonitor = null;
        this._clearStatusItems();

        this._indicator?.destroy();
        this._indicator = null;

        this._box = null;
        this._items?.clear();
        this._items = null;
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
        this._clearStatusItems();

        for (const definition of this._loadConfig())
            this._addStatusItem(definition);
    }

    _addStatusItem(definition) {
        const path = this._expandPath(definition.path);
        const container = new St.BoxLayout({
            y_align: Clutter.ActorAlign.CENTER,
            style: this._buildItemStyle(definition),
        });
        const separator = new St.Label({
            text: definition.separator ?? DEFAULT_SEPARATOR,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const label = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
        });

        container.add_child(separator);
        container.add_child(label);

        this._items.set(definition.id, {
            ...definition,
            path,
            container,
            separator,
            label,
        });

        this._box.add_child(container);
        this._statusMonitors.push(this._watchFile(
            path,
            () => this._reloadStatusItem(definition.id)
        ));
        this._reloadStatusItem(definition.id);
    }

    _clearStatusItems() {
        for (const sourceId of this._reloadSourceIds.values())
            GLib.source_remove(sourceId);

        this._reloadSourceIds.clear();

        for (const monitor of this._statusMonitors)
            this._clearMonitor(monitor);

        this._statusMonitors = [];

        for (const item of this._items.values())
            item.container.destroy();

        this._items.clear();
    }

    _reloadStatusItem(id) {
        const item = this._items.get(id);

        if (!item)
            return;

        const text = this._readFile(item.path) || '';

        item.label.set_text(text);
        item.container.visible = text.length > 0;
    }

    _watchFile(path, reloadCallback) {
        const dir = GLib.path_get_dirname(path);

        try {
            GLib.mkdir_with_parents(dir, 0o700);
        } catch (e) {
            console.error(`Failed to create directory ${dir}: ${e}`);
        }

        const dirFile = Gio.File.new_for_path(dir);

        let monitor;

        try {
            monitor = dirFile.monitor_directory(Gio.FileMonitorFlags.NONE, null);
        } catch (e) {
            console.error(`Failed to monitor directory ${dir}: ${e}`);
            return;
        }

        const handlerId = monitor.connect(
            'changed',
            (_monitor, file, otherFile, _eventType) => {
                const changedPath = file ? file.get_path() : null;
                const otherPath = otherFile ? otherFile.get_path() : null;

                if (changedPath === path || otherPath === path) {
                    this._scheduleReload(path, reloadCallback);
                }
            }
        );

        return {
            path,
            dir,
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
        if (this._reloadSourceIds.has(key))
            return;

        const sourceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            RELOAD_DELAY_MS,
            () => {
                this._reloadSourceIds.delete(key);
                reloadCallback();
                return GLib.SOURCE_REMOVE;
            }
        );

        this._reloadSourceIds.set(key, sourceId);
    }

    _readFile(path) {
        try {
            const file = Gio.File.new_for_path(path);
            const [ok, contents] = file.load_contents(null);

            if (!ok)
                return null;

            return new TextDecoder().decode(contents).trim();
        } catch (e) {
            return null;
        }
    }

    _loadConfig() {
        const contents = this._readFile(this._configPath) ?? this._readFile(this._defaultConfigPath);

        if (!contents)
            return [];

        try {
            const config = JSON.parse(contents);

            if (!Array.isArray(config)) {
                console.error(`${CONFIG_FILE} must contain a JSON array`);
                return [];
            }

            return config.filter(item => this._isValidStatusItem(item));
        } catch (e) {
            console.error(`Failed to parse ${CONFIG_FILE}: ${e}`);
            return [];
        }
    }

    _isValidStatusItem(item) {
        if (!item || typeof item !== 'object') {
            console.error(`${CONFIG_FILE} entries must be objects`);
            return false;
        }

        if (typeof item.id !== 'string' || item.id.length === 0) {
            console.error(`${CONFIG_FILE} entries need a non-empty string id`);
            return false;
        }

        if (typeof item.path !== 'string' || item.path.length === 0) {
            console.error(`${CONFIG_FILE} entry ${item.id} needs a non-empty string path`);
            return false;
        }

        if (item.separator !== undefined && typeof item.separator !== 'string') {
            console.error(`${CONFIG_FILE} entry ${item.id} separator must be a string`);
            return false;
        }

        return true;
    }

    _buildItemStyle(definition) {
        const marginLeft = this._getNumber(
            definition.marginLeft,
            DEFAULT_MARGIN_LEFT_PX
        );
        const marginRight = this._getNumber(
            definition.marginRight,
            DEFAULT_MARGIN_RIGHT_PX
        );

        return `margin-left: ${marginLeft}px; margin-right: ${marginRight}px;`;
    }

    _getNumber(value, fallback) {
        if (typeof value !== 'number' || !Number.isFinite(value))
            return fallback;

        return Math.max(0, Math.round(value));
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
