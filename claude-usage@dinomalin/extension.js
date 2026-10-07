import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

const TICK_SECONDS = 60;
const TRACK_WIDTH = 260;
const WARNING_PERCENT = 75;
const CRITICAL_PERCENT = 90;
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

const WINDOWS = [
    {key: 'five_hour', title: 'Session (5h)', inBar: true},
    {key: 'seven_day', title: 'Weekly (7d)', inBar: true},
];

function parseReset(value) {
    if (value === null || value === undefined)
        return null;
    if (typeof value === 'number')
        return value < 1e12 ? value * 1000 : value;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
}

function normalizeWindows(raw) {
    const windows = {};
    for (const {key} of WINDOWS) {
        const w = raw?.[key];
        if (!w)
            continue;
        const percent = w.used_percentage ?? w.utilization;
        if (percent === null || percent === undefined)
            continue;
        windows[key] = {percent: Number(percent), resetsAt: parseReset(w.resets_at)};
    }
    return windows;
}

function parseStatusline(data) {
    return {
        updatedAt: parseReset(data.updated_at) ?? Date.now(),
        windows: normalizeWindows(data.rate_limits),
    };
}

function parseApiUsage(data) {
    return {
        updatedAt: Date.now(),
        windows: normalizeWindows(data),
    };
}

function parseDesktopHistory(data) {
    const sample = data.samples?.at(-1);
    if (!sample?.u)
        return null;
    return {
        updatedAt: sample.t,
        windows: normalizeWindows({
            five_hour: {used_percentage: sample.u.fh},
            seven_day: {used_percentage: sample.u.sd},
        }),
    };
}

function effectivePercent(window, now) {
    if (window.resetsAt !== null && window.resetsAt <= now)
        return 0;
    return window.percent;
}

function severityClass(percent) {
    if (percent >= CRITICAL_PERCENT)
        return 'claude-usage-critical';
    if (percent >= WARNING_PERCENT)
        return 'claude-usage-warning';
    return null;
}

function formatDuration(ms) {
    const minutes = Math.max(0, Math.round(ms / 60000));
    if (minutes < 60)
        return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24)
        return `${hours}h ${minutes % 60}m`;
    return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function formatReset(resetsAt, now) {
    if (resetsAt === null)
        return '';
    if (resetsAt <= now)
        return 'reset';
    if (resetsAt - now < 24 * 3600 * 1000)
        return `resets in ${formatDuration(resetsAt - now)}`;
    const date = GLib.DateTime.new_from_unix_local(Math.floor(resetsAt / 1000));
    return `resets ${date.format('%a %H:%M')}`;
}

const UsageRow = GObject.registerClass(
class UsageRow extends PopupMenu.PopupBaseMenuItem {
    _init(title) {
        super._init({reactive: false, can_focus: false});

        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'claude-usage-row', x_expand: true});
        const header = new St.BoxLayout({style_class: 'claude-usage-row-header'});
        this._title = new St.Label({text: title, style_class: 'claude-usage-row-title'});
        this._detail = new St.Label({
            style_class: 'claude-usage-row-detail',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
        });
        header.add_child(this._title);
        header.add_child(this._detail);

        this._track = new St.Widget({style_class: 'claude-usage-track', width: TRACK_WIDTH});
        this._fill = new St.Widget({style_class: 'claude-usage-fill', width: 0});
        this._track.add_child(this._fill);

        box.add_child(header);
        box.add_child(this._track);
        this.add_child(box);
    }

    update(window, now) {
        const percent = effectivePercent(window, now);
        const reset = formatReset(window.resetsAt, now);
        this._detail.text = reset ? `${Math.round(percent)}% · ${reset}` : `${Math.round(percent)}%`;
        this._fill.width = Math.round(TRACK_WIDTH * Math.min(100, Math.max(0, percent)) / 100);
        this._fill.style_class = 'claude-usage-fill';
        const severity = severityClass(percent);
        if (severity)
            this._fill.add_style_class_name(severity);
    }
});

const UsageIndicator = GObject.registerClass(
class UsageIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.5, 'Claude Usage');

        const box = new St.BoxLayout({style_class: 'claude-usage-box'});
        box.add_child(new St.Label({
            text: '✻',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'claude-usage-logo',
        }));
        this._label = new St.Label({
            text: '…',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'claude-usage-label',
        });
        box.add_child(this._label);
        this.add_child(box);

        this._rows = {};
        for (const {key, title} of WINDOWS) {
            const row = new UsageRow(title);
            row.visible = false;
            this._rows[key] = row;
            this.menu.addMenuItem(row);
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._status = new PopupMenu.PopupMenuItem('', {reactive: false, can_focus: false});
        this._status.label.style_class = 'claude-usage-status';
        this.menu.addMenuItem(this._status);
    }

    render(snapshot, statusText) {
        const now = Date.now();
        const windows = snapshot?.windows ?? {};

        const parts = [];
        let worst = 0;
        for (const {key, inBar} of WINDOWS) {
            const window = windows[key];
            this._rows[key].visible = Boolean(window);
            if (!window)
                continue;
            this._rows[key].update(window, now);
            const percent = effectivePercent(window, now);
            if (inBar) {
                parts.push(`${Math.round(percent)}%`);
                worst = Math.max(worst, percent);
            }
        }

        this._label.text = parts.length ? parts.join(' · ') : '–';
        this._label.style_class = 'claude-usage-label';
        const severity = severityClass(worst);
        if (severity)
            this._label.add_style_class_name(severity);

        this._status.label.text = statusText;
    }
});

export default class ClaudeUsageExtension extends Extension {
    enable() {
        const cacheDir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'claude-usage']);
        GLib.mkdir_with_parents(cacheDir, 0o755);

        this._cancellable = new Gio.Cancellable();
        this._snapshots = {statusline: null, desktop: null, api: null};
        this._apiError = null;

        this._indicator = new UsageIndicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        const desktopDir = GLib.build_filenamev([GLib.get_user_config_dir(), 'Claude']);
        this._monitors = [];
        const loads = [
            this._watch(cacheDir, 'usage.json', 'statusline', parseStatusline),
            this._watch(desktopDir, 'plan-usage-history.json', 'desktop', parseDesktopHistory),
        ];

        this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TICK_SECONDS, () => {
            this._render();
            return GLib.SOURCE_CONTINUE;
        });

        this._settings = this.getSettings();
        this._settings.connectObject(
            'changed::api-polling', () => this._schedulePolling(),
            'changed::api-interval', () => this._schedulePolling(),
            this);
        this._schedulePolling();

        Promise.all(loads).then(() => this._render());
    }

    disable() {
        if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
        this._stopPolling();
        this._settings?.disconnectObject(this);
        this._settings = null;
        this._cancellable?.cancel();
        this._cancellable = null;
        this._monitors?.forEach(monitor => monitor.cancel());
        this._monitors = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._snapshots = null;
        this._apiError = null;
    }

    _schedulePolling() {
        this._stopPolling();
        this._snapshots.api = null;
        this._apiError = null;
        if (this._settings.get_boolean('api-polling')) {
            this._session = new Soup.Session({user_agent: `gnome-claude-usage/${this.metadata.version}`, timeout: 30});
            this._pollId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, this._settings.get_int('api-interval'), () => {
                this._fetchUsage();
                return GLib.SOURCE_CONTINUE;
            });
            this._fetchUsage();
        }
        this._render();
    }

    _stopPolling() {
        if (this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = 0;
        }
        this._session?.abort();
        this._session = null;
    }

    async _readAccessToken() {
        const configDir = GLib.getenv('CLAUDE_CONFIG_DIR') ?? GLib.build_filenamev([GLib.get_home_dir(), '.claude']);
        const file = Gio.File.new_for_path(GLib.build_filenamev([configDir, '.credentials.json']));
        let contents;
        try {
            [contents] = await file.load_contents_async(this._cancellable);
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                throw new Error('no Claude Code login found');
            throw e;
        }
        const oauth = JSON.parse(new TextDecoder().decode(contents)).claudeAiOauth;
        if (!oauth?.accessToken)
            throw new Error('no Claude Code login found');
        if (oauth.expiresAt && oauth.expiresAt <= Date.now())
            throw new Error('login expired, open Claude Code to refresh it');
        return oauth.accessToken;
    }

    async _fetchUsage() {
        const session = this._session;
        try {
            const token = await this._readAccessToken();
            const message = Soup.Message.new('GET', USAGE_URL);
            message.request_headers.append('Authorization', `Bearer ${token}`);
            message.request_headers.append('anthropic-beta', 'oauth-2025-04-20');
            message.request_headers.append('Accept', 'application/json');
            const bytes = await session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, this._cancellable);
            if (session !== this._session)
                return;
            const status = message.get_status();
            if (status !== Soup.Status.OK)
                throw new Error(`HTTP ${status}`);
            const snapshot = parseApiUsage(JSON.parse(new TextDecoder().decode(bytes.get_data())));
            if (!Object.keys(snapshot.windows).length)
                throw new Error('unexpected response');
            this._snapshots.api = snapshot;
            this._apiError = null;
        } catch (e) {
            if (session !== this._session || e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            this._apiError = e.message;
            console.warn(`claude-usage: usage API request failed: ${e.message}`);
        }
        this._render();
    }

    _latest() {
        const snapshots = Object.values(this._snapshots)
            .filter(Boolean)
            .sort((a, b) => b.updatedAt - a.updatedAt);
        if (!snapshots.length)
            return null;

        const [freshest] = snapshots;
        const now = Date.now();
        const windows = {};
        for (const [key, window] of Object.entries(freshest.windows)) {
            const resetsAt = window.resetsAt ?? snapshots
                .map(snapshot => snapshot.windows[key]?.resetsAt)
                .find(value => value && value > now) ?? null;
            windows[key] = {...window, resetsAt};
        }
        return {...freshest, windows};
    }

    _render() {
        if (!this._indicator)
            return;
        const latest = this._latest();
        const status = latest
            ? `Updated ${formatDuration(Date.now() - latest.updatedAt)} ago`
            : 'No usage data yet';
        this._indicator.render(latest, this._apiError ? `${status}\nAPI: ${this._apiError}` : status);
    }

    _watch(dir, basename, source, parse) {
        const file = Gio.File.new_for_path(GLib.build_filenamev([dir, basename]));
        const monitor = Gio.File.new_for_path(dir).monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
        monitor.connect('changed', (_monitor, changed, other) => {
            if (changed?.get_basename() === basename || other?.get_basename() === basename)
                this._load(file, source, parse);
        });
        this._monitors.push(monitor);
        return this._load(file, source, parse);
    }

    async _load(file, source, parse) {
        try {
            const [contents] = await file.load_contents_async(this._cancellable);
            this._snapshots[source] = parse(JSON.parse(new TextDecoder().decode(contents)));
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                logError(e, `claude-usage: failed to read ${file.get_path()}`);
        }
        this._render();
    }
}
