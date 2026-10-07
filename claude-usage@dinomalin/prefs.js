import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class ClaudeUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window._settings = this.getSettings();

        const group = new Adw.PreferencesGroup({
            title: 'Anthropic API',
            description: 'Reads your Claude Code login from ~/.claude/.credentials.json and asks Anthropic for your usage. ' +
                'This uses an undocumented endpoint that may change without notice.',
        });

        const polling = new Adw.SwitchRow({
            title: 'Poll the usage API',
            subtitle: 'Faster updates than Claude Desktop, which only refreshes every 15 minutes',
        });
        window._settings.bind('api-polling', polling, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(polling);

        const interval = new Adw.SpinRow({
            title: 'Interval',
            subtitle: 'Seconds between requests',
            adjustment: new Gtk.Adjustment({lower: 60, upper: 3600, step_increment: 30, page_increment: 300}),
        });
        window._settings.bind('api-interval', interval, 'value', Gio.SettingsBindFlags.DEFAULT);
        window._settings.bind('api-polling', interval, 'sensitive', Gio.SettingsBindFlags.GET);
        group.add(interval);

        const page = new Adw.PreferencesPage();
        page.add(group);
        window.add(page);
    }
}
