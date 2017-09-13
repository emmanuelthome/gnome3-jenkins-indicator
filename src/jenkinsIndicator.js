/**
 * @author Philipp Hoffmann
 */

const Lang = imports.lang;
const St = imports.gi.St;
const Mainloop = imports.mainloop;
const Glib = imports.gi.GLib;
const Soup = imports.gi.Soup;
const PopupMenu = imports.ui.popupMenu;
const PanelMenu = imports.ui.panelMenu;

const Me = imports.misc.extensionUtils.getCurrentExtension();
const Utils = Me.imports.src.helpers.utils;
const Icon = Me.imports.src.helpers.icon;
const ServerPopupMenu = Me.imports.src.serverPopupMenu;

// set text domain for localized strings
const _ = imports.gettext.domain(Me.metadata['gettext-domain']).gettext;

/*
 * Represents the indicator in the top menu bar.
 */
const JenkinsIndicator = new Lang.Class({
	Name: 'JenkinsIndicator',
	Extends: PanelMenu.Button,

	_init: function(settings, httpSession) {
		this.parent(0.25, "Jenkins Indicator", false );

		// the number of the server this indicator refers to
		this.settings = settings;
		this.httpSession = httpSession;

		// start off with no jobs to display
		this.jobs = [];

		// we will use this later to add a notification source as soon as a notification needs to be displayed
		this.notification_source;

		// lock used to prevent multiple parallel update requests
		this._isRequesting = false;

		// start off with a blue overall indicator
		this._iconActor = Icon.createStatusIcon(Utils.jobStates.getIcon(Utils.jobStates.getDefaultState(), this.settings.green_balls_plugin));
		this.actor.add_actor(this._iconActor);

		// add server popup menu
		this.setMenu(new ServerPopupMenu.ServerPopupMenu(this, this.actor, 0.25, St.Side.TOP, this.notification_source, this.settings, this.httpSession));

		// refresh when indicator is clicked
		this.actor.connect("button-press-event", Lang.bind(this, this.request));

		// enter main loop for refreshing
		this._mainloopInit();
	},

	_mainloopInit: function() {
		// create new main loop
		this._mainloop = Mainloop.timeout_add(this.settings.autorefresh_interval*1000, Lang.bind(this, function(){
			// request new job states if auto-refresh is enabled
			if( this.settings.autorefresh ) {
				this.request();
			}

			// returning true is important for restarting the mainloop after timeout
			return true;
		}));
	},

	_make_get_url: function(path) {
		let url = Utils.urlAppend(this.settings.jenkins_url, path);
		let request = Soup.Message.new('GET', url);
		if( this.settings.use_authentication ) {
			request.request_headers.append('Authorization', 'Basic ' + Glib.base64_encode(this.settings.auth_user + ':' + this.settings.api_token));
		}
		return request
	},

	request_serialized: function(parent_job) {
		/* we assume that this._isRequesting is set */
		let request = this._make_get_url("job/%s/api/json".format(parent_job));
		if (!request) {
			this.showError(_("Invalid Jenkins CI Server web frontend URL"));
			return
		}

		/* synchronous, see function below */
		let response = this.httpSession.send_message(request)

		if (response!==200 ) {
			this.showError(_("Invalid Jenkins URL %s (HTTP Error %s)").format(url, message.status_code));
			return
		}

		try {
			let jenkinsState = JSON.parse(request.response_body.data);
			let subjobs = jenkinsState.jobs;
			for( let i=0 ; i< subjobs.length ; ++i ) {
				let J =  subjobs[i]
				J["name"] = parent_job + "/" + J["name"]
				// global.log("[%d] %s: %s".format(this.jobs.length, J["name"], J["color"]))
				this.jobs.push(J)
			}
		}
		catch (e) {
			global.log(e)
			this.showError(_("Invalid Jenkins CI Server web frontend URL"));
		}
	},

	// request local jenkins server for current state
	request: function() {
		// only update if no update is currently running
		if( !this._isRequesting ) {
			this._isRequesting = true;
			let request = this._make_get_url("api/json");
			if( request ) {
				this.httpSession.queue_message(request, Lang.bind(this, function(httpSession, message) {
					// http error
					if( message.status_code!==200 )	{
						this.showError(_("Invalid Jenkins CI Server web frontend URL (HTTP Error %s)").format(message.status_code));
					}
					// http ok
					else {
						// parse json
						try {
							let jenkinsState = JSON.parse(request.response_body.data);
							let topjobs = jenkinsState.jobs;
							this.jobs = []
							for( let i=0 ; i< topjobs.length ; ++i ) {
								let J = topjobs[i]
								/* TODO: jenkins also has folder jobs IIUC,
								 * we'd like to address them as well */
								if (J["_class"] != "org.jenkinsci.plugins.workflow.multibranch.WorkflowMultiBranchProject") {
									// global.log("[%d] %s: %s".format(this.jobs.length, J["name"], J["color"]))
									this.jobs.push(J)
								} else {
									// the request below is synchronous.
									this.request_serialized(J["name"])
								}
							}

							// update indicator (icon and popupmenu contents)
							// All the requests we need must have been completed
							// at this point, hence the need for synchronous
							// requests in .request_serialized().
							this.update();
						}
						catch( e ) {
							global.log(e)
							this.showError(_("Invalid Jenkins CI Server web frontend URL"));
						}
					}

					// we're done updating and ready for the next request
					this._isRequesting = false;
				}));
			}
			// no valid url was provided in settings dialog
			else {
				this.showError(_("Invalid Jenkins CI Server web frontend URL"));

				// we're done updating and ready for the next request
				this._isRequesting = false;
			}
		}
	},

	// update indicator icon and popupmenu contents
	update: function() {
		// filter jobs to be shown
		let displayJobs = Utils.filterJobs(this.jobs, this.settings);

		// update popup menu
		this.menu.updateJobs(displayJobs);

		// update overall indicator icon

		// default state of overall indicator
		let overallState = Utils.jobStates.getDefaultState();

		// set state to red if there are no jobs
		if( displayJobs.length<=0 ) {
			overallState = Utils.jobStates.getErrorState();
		}
		else {
			// determine jobs overall state for the indicator
			for( let i=0 ; i<displayJobs.length ; ++i )	{
				// set overall job state to highest ranked (most important) state
				if( Utils.jobStates.getRank(displayJobs[i].color)>-1 && Utils.jobStates.getRank(displayJobs[i].color)<Utils.jobStates.getRank(overallState) ) {
					overallState = displayJobs[i].color;
				}
			}
		}

		// set new overall indicator icon representing current jenkins state
		this._iconActor.icon_name = Utils.jobStates.getIcon(overallState, this.settings.green_balls_plugin);
	},

	// update settings
	updateSettings: function(settings) {
		this.settings = settings;

		// update server menu item
		this.menu.updateSettings(this.settings);

		// refresh main loop
		Mainloop.source_remove(this._mainloop);
		this._mainloopInit();

		this.update();
	},

	// displays an error message in the popup menu
	showError: function(text) {
		// set default error message if none provided
		text = text || "unknown error";

		// remove all job menu entries and previous error messages
		this.menu.jobSection.removeAll();

		// show error message in popup menu
		this.menu.jobSection.addMenuItem( new PopupMenu.PopupMenuItem(_("Error") + ": " + text, {style_class: 'error'}) );

		// set indicator state to error
		this._iconActor.icon_name = Utils.jobStates.getIcon(Utils.jobStates.getErrorState(), this.settings.green_balls_plugin);
	},

	// destroys the indicator
	destroy: function() {
		// destroy the mainloop used for updating the indicator
		Mainloop.source_remove(this._mainloop);

		// destroy notification source if used
		if( this.notification_source )
			this.notification_source.destroy();

		this.parent();
	}
});

