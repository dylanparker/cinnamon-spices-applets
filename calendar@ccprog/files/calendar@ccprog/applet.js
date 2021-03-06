/* global imports, _ */
/* eslint camelcase: "off" */

const Applet = imports.ui.applet;
const Gio = imports.gi.Gio;
const Clutter = imports.gi.Clutter;
const St = imports.gi.St;
const Util = imports.misc.util;
const PopupMenu = imports.ui.popupMenu;
const UPowerGlib = imports.gi.UPowerGlib;
const Settings = imports.ui.settings;
const Calendar = require("./calendar");
const Worldclocks = require("./worldclocks");
const CinnamonDesktop = imports.gi.CinnamonDesktop;
const Main = imports.ui.main;

String.prototype.capitalize = function() {
    return this.charAt(0).toUpperCase() + this.slice(1);
};

function _onVertSepRepaint (area)
{
    let cr = area.get_context();
    let themeNode = area.get_theme_node();
    let [width, height] = area.get_surface_size();
    let stippleColor = themeNode.get_color("-stipple-color");
    let stippleWidth = themeNode.get_length("-stipple-width");
    let x = Math.floor(width/2) + 0.5;
    cr.moveTo(x, 0);
    cr.lineTo(x, height);
    Clutter.cairo_set_source_color(cr, stippleColor);
    cr.setDash([1, 3], 1); // Hard-code for now
    cr.setLineWidth(stippleWidth);
    cr.stroke();

    cr.$dispose();
}

class CinnamonCalendarApplet extends Applet.TextApplet {
    constructor(orientation, panel_height, instance_id) {
        super(orientation, panel_height, instance_id);

        this.setAllowedLayout(Applet.AllowedLayout.BOTH);

        try {
            this.menuManager = new PopupMenu.PopupMenuManager(this);
            this.orientation = orientation;

            this.settings = new Settings.AppletSettings(this, "calendar@ccprog", this.instance_id);

            // Calendar
            this.clock = new CinnamonDesktop.WallClock();
            this._calendar = new Calendar.Calendar(this.settings);

            this._initContextMenu();
            this.menu.setCustomStyleClass("calendar-background");

            // Date
            this._date = new St.Label();
            this._date.style_class = "datemenu-date-label";
            this.menu.addActor(this._date);

            this.menu.addActor(this._calendar.actor);
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            let item = new PopupMenu.PopupMenuItem(_("Date and Time Settings"));
            item.connect("activate", this._onLaunchSettings.bind(this));

            this.menu.addMenuItem(item);

            this._dateFormatFull = CinnamonDesktop.WallClock.lctime_format("cinnamon", "%A, %B %-e, %Y");

            this.settings.bind("use-custom-format", "use_custom_format", this._onSettingsChanged);
            this.settings.bind("custom-format", "custom_format", this._onSettingsChanged);
            this.settings.bind("keyOpen", "keyOpen", this._setKeybinding);
            this._setKeybinding();

            /* FIXME: Add gobject properties to the WallClock class to allow easier access from
             * its clients, and possibly a separate signal to notify of updates to these properties
             * (though GObject "changed" would be sufficient.) */
            this.desktop_settings = new Gio.Settings({ schema_id: "org.cinnamon.desktop.interface" });
            this.desktop_settings.connect("changed::clock-use-24h", () => this._onSettingsChanged());
            this.desktop_settings.connect("changed::clock-show-seconds", () => this._onSettingsChanged());

            this.clock_notify_id = 0;

            // https://bugzilla.gnome.org/show_bug.cgi?id=655129
            this._upClient = new UPowerGlib.Client();
            try {
                this._upClient.connect("notify-resume", this._updateClockAndDate.bind(this));
            } catch (e) {
                this._upClient.connect("notify::resume", this._updateClockAndDate.bind(this));
            }

            this.settings.connect("changed::worldclocks",this._onWorldclocksChanged.bind(this));
            this.worldsettings = {
                clocks: this.settings.getValue('worldclocks')
            };

            this._worldclocks = new Worldclocks.Worldclocks(this.menu);

            this._updateFormatString();
        }
        catch (e) {
            global.logError(e);
        }
    }

    _onWorldclocksChanged(setting_provider, oldval, newval) {
        this.worldsettings.clocks = newval;
        this._worldclocks.buildClocks(this.worldsettings);
        this._worldclocks.updateClocks();
    }

    _setKeybinding() {
        Main.keybindingManager.addHotKey("calendar-open-" + this.instance_id, this.keyOpen, this._openMenu.bind(this));
    }

    _clockNotify(obj, pspec, data) {
        this._updateClockAndDate();
    }

    on_applet_clicked(event) {
        this._openMenu();
    }
    
    _openMenu() {
        this.menu.toggle();
    }

    _onSettingsChanged() {
        this._updateFormatString();
        this._updateClockAndDate();
    }

    on_custom_format_button_pressed() {
        Util.spawnCommandLine("xdg-open http://www.foragoodstrftime.com/");
    }

    _onLaunchSettings() {
        this.menu.close();
        Util.spawnCommandLine("cinnamon-settings calendar");
    }

    _updateFormatString() {
        let in_vertical_panel = (this.orientation === St.Side.LEFT || this.orientation === St.Side.RIGHT);
        let world_string = this.custom_format;
        let main_string = this.custom_format;

        if (this.use_custom_format) {
            if (!this.clock.set_format_string(world_string)) {
                global.logError("Calendar applet: bad time format string - check your string.");
                world_string = main_string = "~CLOCK FORMAT ERROR~ %l:%M %p";
            }
        } else {
            let use_24h = this.desktop_settings.get_boolean("clock-use-24h");
            let show_seconds = this.desktop_settings.get_boolean("clock-show-seconds");

            if (use_24h) {
                main_string = show_seconds ? "%H%n%M%n%S" : "%H%n%M%";
                world_string = show_seconds ? "%H:%M:%S (%a)" : "%H:%M (%a)";
            } else {
                main_string = show_seconds ? "%l%n%M%n%S" : "%l%n%M%";
                world_string = show_seconds ? "%l:%M:%S (%a)" : "%l:%M (%a)";
            }
            if (!in_vertical_panel) main_string = null;
        }

        this.clock.set_format_string(main_string);
        this.worldsettings.format = world_string;
        this._worldclocks.buildClocks(this.worldsettings);
    }

    _updateClockAndDate() {
        let label_string = this.clock.get_clock();

        if (!this.use_custom_format) {
            label_string = label_string.capitalize();
        }

        this.set_applet_label(label_string);

        /* Applet content - st_label_set_text and set_applet_tooltip both compare new to
         * existing strings before proceeding, so no need to check here also */
        let dateFormattedFull = this.clock.get_clock_for_format(this._dateFormatFull).capitalize();

        this._date.set_text(dateFormattedFull);
        this.set_applet_tooltip(dateFormattedFull);

        this._worldclocks.updateClocks();
    }

    on_applet_added_to_panel() {
        this._onSettingsChanged();

        if (this.clock_notify_id === 0) {
            this.clock_notify_id = this.clock.connect("notify::clock", () => this._clockNotify());
        }

        /* Populates the calendar so our menu allocation is correct for animation */
        this._updateCalendar();
    }

    on_applet_removed_from_panel() {
        Main.keybindingManager.removeHotKey("calendar-open-" + this.instance_id);
        if (this.clock_notify_id > 0) {
            this.clock.disconnect(this.clock_notify_id);
            this.clock_notify_id = 0;
        }
    }

    _initContextMenu () {
        this.menu = new Applet.AppletPopupMenu(this, this.orientation);
        this.menuManager.addMenu(this.menu);

        // Whenever the menu is opened, select today
        this.menu.connect("open-state-changed", (menu, isOpen) => {
            if (isOpen) {
                this._updateCalendar();
            }
        });
    }

    _updateCalendar () {
        this._calendar.setDate(new Date(), true);
        this._worldclocks.updateClocks();
    }

    on_orientation_changed (orientation) {
        this.orientation = orientation;
        this.menu.setOrientation(orientation);
        this._onSettingsChanged();
    }
}

function main(metadata, orientation, panel_height, instance_id) {
    return new CinnamonCalendarApplet(orientation, panel_height, instance_id);
}