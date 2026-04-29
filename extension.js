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
const DEBUG = false;

export default class TopbarWatchExtension extends Extension {
    enable() {
        this._enabled = true;
        this._configMonitor = null;
        this._statusMonitors = [];
        this._reloadSourceIds = new Map();
        this._items = new Map();
        this._reloadConfigSerial = 0;
        this._indicatorHandlerId = null;
        this._runtimeDir = GLib.getenv('XDG_RUNTIME_DIR') || GLib.get_user_runtime_dir();
        this._defaultConfigPath = this._getExtensionFilePath(CONFIG_FILE);
        this._configPath = this._getUserConfigPath();

        this._indicator = new PanelMenu.Button(0.0, this.metadata.name, false);
        this._indicator.set_style('padding-left: 0px; padding-right: 0px;');
        this._indicatorHandlerId = this._indicator.connect('button-press-event', () => {
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

        if (this._indicator && this._indicatorHandlerId) {
            this._indicator.disconnect(this._indicatorHandlerId);
            this._indicatorHandlerId = null;
        }

        this._box?.destroy();
        this._box = null;

        this._indicator?.destroy();
        this._indicator = null;

        this._items?.clear();
        this._items = null;
        this._statusMonitors = null;
        this._reloadSourceIds = null;
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

        this._loadConfigAsync().then(definitions => {
            if (!this._enabled || serial !== this._reloadConfigSerial || !this._box)
                return;

            for (const definition of definitions)
                this._addStatusItem(definition);
        });
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
        });
    }

    _watchFile(path, reloadCallback) {
        const dir = GLib.path_get_dirname(path);

        try {
            GLib.mkdir_with_parents(dir, 0o700);
        } catch (e) {
            this._logError(`Failed to create directory ${dir}`, e);
        }

        const dirFile = Gio.File.new_for_path(dir);

        let monitor;

        try {
            monitor = dirFile.monitor_directory(Gio.FileMonitorFlags.NONE, null);
        } catch (e) {
            this._logError(`Failed to monitor directory ${dir}`, e);
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
                } catch (e) {
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
            return [];

        try {
            const config = JSON.parse(contents);

            if (!Array.isArray(config)) {
                this._logError(`${CONFIG_FILE} must contain a JSON array`);
                return [];
            }

            return config.filter(item => this._isValidStatusItem(item));
        } catch (e) {
            this._logError(`Failed to parse ${CONFIG_FILE}`, e);
            return [];
        }
    }

    _isValidStatusItem(item) {
        if (!item || typeof item !== 'object') {
            this._logError(`${CONFIG_FILE} entries must be objects`);
            return false;
        }

        if (typeof item.id !== 'string' || item.id.length === 0) {
            this._logError(`${CONFIG_FILE} entries need a non-empty string id`);
            return false;
        }

        if (typeof item.path !== 'string' || item.path.length === 0) {
            this._logError(`${CONFIG_FILE} entry ${item.id} needs a non-empty string path`);
            return false;
        }

        if (item.separator !== undefined && typeof item.separator !== 'string') {
            this._logError(`${CONFIG_FILE} entry ${item.id} separator must be a string`);
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

    _logError(message, error = null) {
        if (!DEBUG)
            return;

        console.error(`[${this.metadata.name}] ${message}${error ? `: ${error}` : ''}`);
    }
}
