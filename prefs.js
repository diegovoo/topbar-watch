import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const CONFIG_FILE = 'status-items.json';
const CONFIG_DIR = 'topbar-watch';
const DEFAULT_MARGIN_LEFT_PX = 8;
const DEFAULT_MARGIN_RIGHT_PX = 12;
const DEFAULT_SEPARATOR = '|';

export default class TopbarWatchPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.set_default_size(720, 620);
        const page = new TopbarWatchPreferencesPage(this);
        window.add(page.widget);
    }
}

class TopbarWatchPreferencesPage {
    constructor(extension) {
        this.widget = new Adw.PreferencesPage({
            title: 'Topbar Watch',
            icon_name: 'preferences-system-symbolic',
        });

        this._extension = extension;
        this._defaultConfigPath = this._getExtensionFilePath(CONFIG_FILE);
        this._configPath = GLib.build_filenamev([
            GLib.get_user_config_dir(),
            CONFIG_DIR,
            CONFIG_FILE,
        ]);
        this._items = this._loadConfig();
        this._itemRows = [];

        this._build();
    }

    _build() {
        this._group = new Adw.PreferencesGroup({
            title: 'Status Items',
            description: 'Each item watches a text file and shows its current contents in the top bar.',
        });
        this.widget.add(this._group);

        const actions = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            halign: Gtk.Align.END,
            margin_top: 12,
            margin_bottom: 12,
        });

        const addButton = new Gtk.Button({
            label: 'Add Item',
            icon_name: 'list-add-symbolic',
        });
        addButton.connect('clicked', () => this._addItem());
        actions.append(addButton);

        const resetButton = new Gtk.Button({
            label: 'Reset to Defaults',
            icon_name: 'edit-undo-symbolic',
        });
        resetButton.connect('clicked', () => this._resetToDefaults());
        actions.append(resetButton);

        this._group.add(this._createButtonRow(actions));
        this._refreshRows();
    }

    _refreshRows() {
        for (const row of this._itemRows)
            this._group.remove(row);

        this._itemRows = [];

        this._items.forEach((item, index) => {
            const row = this._createItemRow(item, index);
            this._itemRows.push(row);
            this._group.add(row);
        });
    }

    _createItemRow(item, index) {
        const row = new Adw.ExpanderRow({
            title: item.id || 'New item',
            subtitle: item.path || '',
        });

        const removeButton = new Gtk.Button({
            icon_name: 'user-trash-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Remove item',
            css_classes: ['flat', 'destructive-action'],
        });
        removeButton.connect('clicked', () => {
            this._items.splice(index, 1);
            this._save();
            this._refreshRows();
        });
        row.add_suffix(removeButton);

        const idRow = new Adw.EntryRow({
            title: 'ID',
            text: item.id ?? '',
        });
        idRow.connect('notify::text', () => {
            item.id = idRow.text.trim();
            row.title = item.id || 'New item';
            this._save();
        });
        row.add_row(idRow);

        const pathRow = new Adw.EntryRow({
            title: 'Watched file path',
            text: item.path ?? '',
        });
        pathRow.connect('notify::text', () => {
            item.path = pathRow.text.trim();
            row.subtitle = item.path;
            this._save();
        });
        row.add_row(pathRow);

        const separatorRow = new Adw.EntryRow({
            title: 'Separator',
            text: item.separator ?? DEFAULT_SEPARATOR,
        });
        separatorRow.connect('notify::text', () => {
            item.separator = separatorRow.text;
            this._save();
        });
        row.add_row(separatorRow);

        row.add_row(this._createSpinRow(
            'Left margin',
            item.marginLeft ?? DEFAULT_MARGIN_LEFT_PX,
            value => {
                item.marginLeft = value;
                this._save();
            }
        ));
        row.add_row(this._createSpinRow(
            'Right margin',
            item.marginRight ?? DEFAULT_MARGIN_RIGHT_PX,
            value => {
                item.marginRight = value;
                this._save();
            }
        ));

        return row;
    }

    _createSpinRow(title, value, changedCallback) {
        const adjustment = new Gtk.Adjustment({
            lower: 0,
            upper: 128,
            step_increment: 1,
            page_increment: 4,
            value,
        });
        const row = new Adw.SpinRow({
            title,
            adjustment,
            numeric: true,
            digits: 0,
        });

        row.connect('notify::value', () => changedCallback(Math.round(row.value)));
        return row;
    }

    _createButtonRow(child) {
        const row = new Adw.PreferencesRow({
            activatable: false,
        });
        row.set_child(child);
        return row;
    }

    _addItem() {
        this._items.push({
            id: `item-${this._items.length + 1}`,
            path: '$XDG_RUNTIME_DIR/status.txt',
            separator: DEFAULT_SEPARATOR,
            marginLeft: DEFAULT_MARGIN_LEFT_PX,
            marginRight: DEFAULT_MARGIN_RIGHT_PX,
        });
        this._save();
        this._refreshRows();
    }

    _resetToDefaults() {
        this._items = this._loadConfig(this._defaultConfigPath);
        this._save();
        this._refreshRows();
    }

    _loadConfig(path = this._configPath) {
        const contents = this._readFile(path) ?? this._readFile(this._defaultConfigPath);

        if (!contents)
            return [];

        try {
            const items = JSON.parse(contents);

            if (!Array.isArray(items))
                return [];

            return items
                .filter(item => item && typeof item === 'object')
                .map(item => ({
                    id: typeof item.id === 'string' ? item.id : '',
                    path: typeof item.path === 'string' ? item.path : '',
                    separator: typeof item.separator === 'string' ? item.separator : DEFAULT_SEPARATOR,
                    marginLeft: this._getNumber(item.marginLeft, DEFAULT_MARGIN_LEFT_PX),
                    marginRight: this._getNumber(item.marginRight, DEFAULT_MARGIN_RIGHT_PX),
                }));
        } catch (e) {
            console.error(`Failed to parse ${CONFIG_FILE}: ${e}`);
            return [];
        }
    }

    _save() {
        const dir = GLib.path_get_dirname(this._configPath);

        try {
            GLib.mkdir_with_parents(dir, 0o700);
            const file = Gio.File.new_for_path(this._configPath);
            file.replace_contents(
                JSON.stringify(this._items, null, 2),
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );
        } catch (e) {
            console.error(`Failed to save ${CONFIG_FILE}: ${e}`);
        }
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

    _getNumber(value, fallback) {
        if (typeof value !== 'number' || !Number.isFinite(value))
            return fallback;

        return Math.max(0, Math.round(value));
    }

    _getExtensionFilePath(filename) {
        if (this._extension.dir)
            return this._extension.dir.get_child(filename).get_path();

        return GLib.build_filenamev([this._extension.path, filename]);
    }
}
