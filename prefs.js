import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const CONFIG_FILE = 'status-items.json';
const CONFIG_DIR = 'topbar-watch';
const DEFAULT_SEPARATOR_STYLE = 'pipe';
const DEFAULT_SPACING = 'balanced';
const DEFAULT_LEADING_SEPARATOR = false;
const DEFAULT_TRAILING_SEPARATOR = false;
const DEFAULT_PREVIEW_TEXT = 'sample';

const SEPARATOR_STYLES = [
    { id: 'none', label: 'None', text: '' },
    { id: 'dot', label: 'Dot', text: '·' },
    { id: 'pipe', label: 'Pipe', text: '|' },
    { id: 'slash', label: 'Slash', text: '/' },
    { id: 'bullet', label: 'Bullet', text: '•' },
];

const SPACING_PRESETS = [
    { id: 'compact', label: 'Compact', previewGap: ' ' },
    { id: 'balanced', label: 'Balanced', previewGap: '  ' },
    { id: 'roomy', label: 'Roomy', previewGap: '   ' },
];

export default class TopbarWatchPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.set_default_size(760, 640);
        const page = new TopbarWatchPreferencesPage(this);
        window.add(page.widget);
    }
}

class TopbarWatchPreferencesPage {
    constructor(extension) {
        this.widget = new Adw.PreferencesPage({
            title: 'Topbar Watch',
            icon_name: 'utilities-system-monitor-symbolic',
        });

        this._extension = extension;
        this._defaultConfigPath = this._getExtensionFilePath(CONFIG_FILE);
        this._configPath = GLib.build_filenamev([
            GLib.get_user_config_dir(),
            CONFIG_DIR,
            CONFIG_FILE,
        ]);
        this._config = this._loadConfig();
        this._items = this._config.items;
        this._itemRows = [];

        this._build();
    }

    _build() {
        const configGroup = new Adw.PreferencesGroup({
            title: 'Configuration',
            description: 'Watched files can be updated by any script or process that writes a line of text.',
        });
        this.widget.add(configGroup);

        const configRow = new Adw.ActionRow({
            title: 'User configuration',
            subtitle: this._configPath,
        });
        configGroup.add(configRow);

        const resetRow = new Adw.ActionRow({
            title: 'Restore default items',
            subtitle: 'Replace your current list with the bundled example configuration.',
        });
        const resetButton = new Gtk.Button({
            label: 'Reset',
            icon_name: 'edit-undo-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['destructive-action'],
        });
        resetButton.connect('clicked', () => this._resetToDefaults());
        resetRow.add_suffix(resetButton);
        resetRow.set_activatable_widget(resetButton);
        configGroup.add(resetRow);

        const appearanceGroup = new Adw.PreferencesGroup({
            title: 'Appearance',
            description: 'Choose how watched items are separated in the top bar.',
        });
        this.widget.add(appearanceGroup);

        this._separatorRow = this._createComboRow(
            'Separator style',
            'Shown between visible status items.',
            SEPARATOR_STYLES,
            this._config.separatorStyle,
            value => {
                this._config.separatorStyle = value;
                this._save();
                this._updatePreview();
            }
        );
        appearanceGroup.add(this._separatorRow);

        this._spacingRow = this._createComboRow(
            'Spacing',
            'Controls the gap between visible status items.',
            SPACING_PRESETS,
            this._config.spacing,
            value => {
                this._config.spacing = value;
                this._save();
                this._updatePreview();
            }
        );
        appearanceGroup.add(this._spacingRow);

        const leadingSeparatorRow = new Adw.SwitchRow({
            title: 'Leading separator',
            subtitle: 'Show the separator before the first visible item.',
            active: this._config.leadingSeparator,
        });
        leadingSeparatorRow.connect('notify::active', () => {
            this._config.leadingSeparator = leadingSeparatorRow.active;
            this._save();
            this._updatePreview();
        });
        appearanceGroup.add(leadingSeparatorRow);

        const trailingSeparatorRow = new Adw.SwitchRow({
            title: 'Trailing separator',
            subtitle: 'Show the separator after the last visible item.',
            active: this._config.trailingSeparator,
        });
        trailingSeparatorRow.connect('notify::active', () => {
            this._config.trailingSeparator = trailingSeparatorRow.active;
            this._save();
            this._updatePreview();
        });
        appearanceGroup.add(trailingSeparatorRow);

        this._previewRow = new Adw.ActionRow({
            title: 'Preview',
        });
        appearanceGroup.add(this._previewRow);
        this._updatePreview();

        this._itemsGroup = new Adw.PreferencesGroup({
            title: 'Status Items',
            description: 'Each item watches one text file and shows its current contents in the top bar. You can reorder the items by dragging them up or down.',
        });
        this.widget.add(this._itemsGroup);

        const addRow = new Adw.ActionRow({
            title: 'Add watched item',
            subtitle: 'Create a new top-bar entry backed by a text file.',
        });
        const addButton = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            tooltip_text: 'Add item',
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });
        addButton.connect('clicked', () => this._addItem());
        addRow.add_suffix(addButton);
        addRow.set_activatable_widget(addButton);
        this._itemsGroup.add(addRow);
        this._refreshRows();
    }

    _refreshRows() {
        for (const row of this._itemRows)
            this._itemsGroup.remove(row);

        this._itemRows = [];

        this._items.forEach((item, index) => {
            const row = this._createItemRow(item, index);
            this._itemRows.push(row);
            this._itemsGroup.add(row);
        });
    }

    _createItemRow(item, index) {
        const row = new Adw.ExpanderRow({
            title: item.id || 'New item',
            subtitle: item.path || 'No file path set',
        });
        this._addDragAndDrop(row, index);

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
            this._updatePreview();
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
            this._updatePreview();
        });
        row.add_row(idRow);

        const pathRow = new Adw.EntryRow({
            title: 'Watched file path',
            text: item.path ?? '',
        });
        pathRow.connect('notify::text', () => {
            item.path = pathRow.text.trim();
            row.subtitle = item.path || 'No file path set';
            this._save();
        });
        row.add_row(pathRow);

        return row;
    }

    _createComboRow(title, subtitle, options, selectedValue, changedCallback) {
        const row = new Adw.ComboRow({
            title,
            subtitle,
            model: Gtk.StringList.new(options.map(option => option.label)),
        });
        const selectedIndex = options.findIndex(option => option.id === selectedValue);
        row.selected = selectedIndex >= 0 ? selectedIndex : 0;
        row.connect('notify::selected', () => {
            const option = options[row.selected];

            if (option)
                changedCallback(option.id);
        });
        return row;
    }

    _updatePreview() {
        if (!this._previewRow)
            return;

        const separator = this._getOption(
            SEPARATOR_STYLES,
            this._config.separatorStyle,
            DEFAULT_SEPARATOR_STYLE
        ).text;
        const gap = this._getOption(
            SPACING_PRESETS,
            this._config.spacing,
            DEFAULT_SPACING
        ).previewGap;

        const visibleTexts = this._items
            .map((item, index) => this._getPreviewText(item, index))
            .filter(text => text.length > 0);

        const parts = [];

        if (separator && this._config.leadingSeparator)
            parts.push(separator, gap);

        visibleTexts.forEach((text, index) => {
            if (index > 0)
                parts.push(separator ? `${gap}${separator}${gap}` : gap);

            parts.push(text);
        });

        if (separator && parts.length > 0 && this._config.trailingSeparator)
            parts.push(gap, separator);

        this._previewRow.subtitle = parts.length > 0
            ? parts.join('')
            : 'No visible status text';
    }

    _getPreviewText(item, index) {
        const text = this._readFile(this._expandPath(item.path)) ?? '';

        if (text)
            return text;

        if (item.path)
            return '';

        return item.id || `${DEFAULT_PREVIEW_TEXT}-${index + 1}`;
    }

    _addDragAndDrop(row, index) {
        const dragSource = new Gtk.DragSource({
            actions: Gdk.DragAction.MOVE,
        });
        dragSource.connect('prepare', () => Gdk.ContentProvider.new_for_value(index));
        row.add_controller(dragSource);

        const dropTarget = Gtk.DropTarget.new(GObject.TYPE_INT, Gdk.DragAction.MOVE);
        dropTarget.connect('drop', (_target, sourceIndex, _x, y) => {
            const insertAfter = y > row.get_allocated_height() / 2;
            this._moveItem(Number(sourceIndex), index + (insertAfter ? 1 : 0));
            return true;
        });
        row.add_controller(dropTarget);
    }

    _moveItem(sourceIndex, targetIndex) {
        if (!Number.isInteger(sourceIndex))
            return;

        if (sourceIndex < 0 || sourceIndex >= this._items.length)
            return;

        let insertIndex = Math.max(0, Math.min(targetIndex, this._items.length));

        if (sourceIndex < insertIndex)
            insertIndex--;

        if (sourceIndex === insertIndex)
            return;

        const [item] = this._items.splice(sourceIndex, 1);
        this._items.splice(insertIndex, 0, item);
        this._save();
        this._refreshRows();
        this._updatePreview();
    }

    _addItem() {
        this._items.push({
            id: `item-${this._items.length + 1}`,
            path: '$XDG_RUNTIME_DIR/status.txt',
        });
        this._save();
        this._refreshRows();
        this._updatePreview();
    }

    _resetToDefaults() {
        this._config = this._loadConfig(this._defaultConfigPath);
        this._items = this._config.items;
        this._save();
        this._refreshRows();
        this._updatePreview();
        this._syncAppearanceRows();
    }

    _loadConfig(path = this._configPath) {
        const contents = this._readFile(path) ?? this._readFile(this._defaultConfigPath);

        if (!contents)
            return this._createDefaultConfig();

        try {
            const config = JSON.parse(contents);

            if (!config || typeof config !== 'object' || Array.isArray(config))
                return this._createDefaultConfig();

            const separatorStyle = this._hasOption(SEPARATOR_STYLES, config.separatorStyle)
                ? config.separatorStyle
                : DEFAULT_SEPARATOR_STYLE;
            const spacing = this._hasOption(SPACING_PRESETS, config.spacing)
                ? config.spacing
                : DEFAULT_SPACING;
            const leadingSeparator = typeof config.leadingSeparator === 'boolean'
                ? config.leadingSeparator
                : DEFAULT_LEADING_SEPARATOR;
            const trailingSeparator = typeof config.trailingSeparator === 'boolean'
                ? config.trailingSeparator
                : DEFAULT_TRAILING_SEPARATOR;
            const items = Array.isArray(config.items) ? config.items : [];

            return {
                separatorStyle,
                spacing,
                leadingSeparator,
                trailingSeparator,
                items: items
                    .filter(item => item && typeof item === 'object')
                    .map(item => ({
                        id: typeof item.id === 'string' ? item.id : '',
                        path: typeof item.path === 'string' ? item.path : '',
                    })),
            };
        } catch (e) {
            console.error(`Failed to parse ${CONFIG_FILE}: ${e}`);
            return this._createDefaultConfig();
        }
    }

    _save() {
        const dir = GLib.path_get_dirname(this._configPath);

        try {
            GLib.mkdir_with_parents(dir, 0o700);
            const file = Gio.File.new_for_path(this._configPath);
            file.replace_contents(
                JSON.stringify(this._config, null, 2),
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

    _expandPath(path) {
        const runtimeDir = GLib.getenv('XDG_RUNTIME_DIR') || GLib.get_user_runtime_dir();
        let expanded = path
            .replaceAll('$XDG_RUNTIME_DIR', runtimeDir)
            .replaceAll('${XDG_RUNTIME_DIR}', runtimeDir)
            .replaceAll('$HOME', GLib.get_home_dir())
            .replaceAll('${HOME}', GLib.get_home_dir());

        if (expanded.startsWith('~/'))
            expanded = GLib.build_filenamev([GLib.get_home_dir(), expanded.slice(2)]);

        return expanded;
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

    _hasOption(options, id) {
        return options.some(option => option.id === id);
    }

    _getOption(options, id, fallback) {
        return options.find(option => option.id === id) ??
            options.find(option => option.id === fallback);
    }

    _syncAppearanceRows() {
        this._separatorRow.selected = Math.max(0, SEPARATOR_STYLES.findIndex(
            option => option.id === this._config.separatorStyle));
        this._spacingRow.selected = Math.max(0, SPACING_PRESETS.findIndex(
            option => option.id === this._config.spacing));
    }

    _getExtensionFilePath(filename) {
        if (this._extension.dir)
            return this._extension.dir.get_child(filename).get_path();

        return GLib.build_filenamev([this._extension.path, filename]);
    }
}
