/**
 * Status bar item for the active note: live sync state and who else is in
 * the note. Click to start or stop live sync. Hidden for unlinked notes.
 */

import {setIcon, setTooltip, type TFile} from "obsidian";
import type {LiveSyncManager} from "../live/manager";
import type {LiveStatus} from "../live/session";

const LABELS: Record<LiveStatus["state"], {icon: string; text: string; tip: string}> = {
	connecting: {icon: "loader", text: "Connecting", tip: "Connecting to hedgedoc..."},
	live: {icon: "radio", text: "Live", tip: "Live sync is on: changes are sent and received as they happen."},
	"read-only": {icon: "eye", text: "Live (read-only)", tip: "You cannot edit this hedgedoc note: remote changes are received, local changes are not sent."},
	offline: {icon: "wifi-off", text: "Offline", tip: "Connection lost; reconnecting. Edits made meanwhile are merged when the connection returns."},
	stopped: {icon: "radio", text: "", tip: ""},
};

export class LiveStatusBar {
	private readonly iconEl: HTMLElement;
	private readonly textEl: HTMLElement;

	constructor(
		private readonly el: HTMLElement,
		private readonly live: LiveSyncManager,
		private readonly activeFile: () => TFile | null,
		private readonly isLinked: (file: TFile) => boolean,
		onClick: (file: TFile) => void,
	) {
		el.addClass("hedgesync-status", "mod-clickable");
		this.iconEl = el.createSpan({cls: "hedgesync-status-icon"});
		this.textEl = el.createSpan({cls: "hedgesync-status-text"});
		el.addEventListener("click", () => {
			const file = this.activeFile();
			if (file !== null) onClick(file);
		});
		this.render();
	}

	render(): void {
		const file = this.activeFile();
		if (file === null || (!this.isLinked(file) && !this.live.isLive(file.path))) {
			this.el.hide();
			return;
		}
		this.el.show();
		const status = this.live.status(file.path);
		if (status === null) {
			setIcon(this.iconEl, "radio");
			this.textEl.setText("Hedgedoc");
			this.el.removeClass("is-live", "is-offline");
			setTooltip(this.el, "Linked to hedgedoc. Click to start live sync.", {placement: "top"});
			return;
		}
		const label = LABELS[status.state];
		setIcon(this.iconEl, label.icon);
		const others = status.others.length;
		this.textEl.setText(others > 0 ? `${label.text} · ${others} online` : label.text);
		this.el.toggleClass("is-live", status.state === "live");
		this.el.toggleClass("is-offline", status.state === "offline");
		const names = status.others.map((user) => user.name ?? "Guest").join(", ");
		setTooltip(this.el, `${label.tip}${others > 0 ? `\nAlso here: ${names}` : ""}\nClick to stop live sync.`, {placement: "top"});
	}
}
