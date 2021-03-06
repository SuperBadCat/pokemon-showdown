import {FS} from '../lib/fs';

export type GroupSymbol = '~' | '&' | '#' | '★' | '*' | '@' | '%' | '☆' | '+' | ' ' | '‽' | '!';
export type EffectiveGroupSymbol = GroupSymbol | 'whitelist';

export const PLAYER_SYMBOL: GroupSymbol = '\u2606';
export const HOST_SYMBOL: GroupSymbol = '\u2605';

export const ROOM_PERMISSIONS = [
	'addhtml', 'announce', 'ban', 'bypassafktimer', 'declare', 'editprivacy', 'editroom', 'exportinputlog', 'game', 'gamemanagement', 'gamemoderation', 'joinbattle', 'kick', 'minigame', 'modchat', 'modchatall', 'modlog', 'mute', 'nooverride', 'receiveauthmessages', 'roombot', 'roomdriver', 'roommod', 'roomowner', 'roomvoice', 'show', 'showmedia', 'timer', 'tournaments', 'warn',
] as const;

export const GLOBAL_PERMISSIONS = [
	// administrative
	'bypassall', 'console', 'disableladder', 'lockdown', 'potd', 'rawpacket',
	// other
	'addhtml', 'alts', 'autotimer', 'globalban', 'bypassblocks', 'bypassafktimer', 'forcepromote', 'forcerename', 'forcewin', 'gdeclare', 'ignorelimits', 'importinputlog', 'ip', 'lock', 'makeroom', 'modlog', 'rangeban', 'promote',
] as const;

export type RoomPermission = typeof ROOM_PERMISSIONS[number];
export type GlobalPermission = typeof GLOBAL_PERMISSIONS[number];

export type GroupInfo = {
	symbol: GroupSymbol,
	id: ID,
	name: string,
	rank: number,
	inherit?: GroupSymbol,
	jurisdiction?: string,

	globalonly?: boolean,
	roomonly?: boolean,
	battleonly?: boolean,
	root?: boolean,
	globalGroupInPersonalRoom?: GroupSymbol,
} & {
	[P in RoomPermission | GlobalPermission]?: string | boolean;
};

/**
 * Auth table - a Map for which users are in which groups.
 *
 * Notice that auth.get will return the default group symbol if the
 * user isn't in a group.
 */
export abstract class Auth extends Map<ID, GroupSymbol | ''> {
	/**
	 * Will return the default group symbol if the user isn't in a group.
	 *
	 * Passing a User will read `user.group`, which is relevant for unregistered
	 * users with temporary global auth.
	 */
	get(user: ID | User) {
		if (typeof user !== 'string') return (user as User).group;
		return super.get(user) || Auth.defaultSymbol();
	}
	isStaff(userid: ID) {
		return this.has(userid) && this.get(userid) !== '+';
	}
	atLeast(user: User, group: GroupSymbol) {
		if (!Config.groups[group]) return false;
		if (user.locked || user.semilocked) return false;
		if (this.get(user.id) === ' ' && group !== ' ') return false;
		return Auth.getGroup(this.get(user.id)).rank >= Auth.getGroup(group).rank;
	}

	static defaultSymbol() {
		return Config.groupsranking[0] as GroupSymbol;
	}
	static getGroup(symbol: EffectiveGroupSymbol): GroupInfo;
	static getGroup<T>(symbol: EffectiveGroupSymbol, fallback: T): GroupInfo | T;
	static getGroup(symbol: EffectiveGroupSymbol, fallback?: AnyObject) {
		if (Config.groups[symbol]) return Config.groups[symbol];

		if (fallback !== undefined) return fallback;

		// unidentified groups are treated as voice
		return Object.assign({}, Config.groups['+'] || {}, {
			symbol,
			id: 'voice',
			name: symbol,
		});
	}
	getEffectiveSymbol(user: User): EffectiveGroupSymbol {
		const group = this.get(user);
		if (this.has(user.id) && group === Auth.defaultSymbol()) {
			return 'whitelist';
		}
		return group;
	}
	static hasPermission(
		user: User,
		permission: string,
		target: User | GroupSymbol | null,
		room?: Room | BasicRoom | null
	): boolean {
		if (user.hasSysopAccess()) return true;

		const auth: Auth = room ? room.auth : Users.globalAuth;

		const symbol = auth.getEffectiveSymbol(user);
		const targetSymbol = (typeof target === 'string' || !target) ? target : auth.get(target);

		const group = Auth.getGroup(symbol);
		if (group['root']) return true;

		let jurisdiction = group[permission as GlobalPermission | RoomPermission];
		if (jurisdiction === true && permission !== 'jurisdiction') {
			jurisdiction = group['jurisdiction'] || true;
		}

		return Auth.hasJurisdiction(symbol, jurisdiction, targetSymbol, target === user);
	}
	static hasJurisdiction(
		symbol: EffectiveGroupSymbol,
		jurisdiction?: string | boolean,
		targetSymbol?: GroupSymbol | null,
		targetingSelf?: boolean
	) {
		if (!targetSymbol) {
			return !!jurisdiction;
		}
		if (typeof jurisdiction !== 'string') {
			return !!jurisdiction;
		}
		if (jurisdiction.includes(targetSymbol)) {
			return true;
		}
		if (jurisdiction.includes('s') && targetingSelf) {
			return true;
		}
		if (jurisdiction.includes('u') &&
			Config.groupsranking.indexOf(symbol) > Config.groupsranking.indexOf(targetSymbol)) {
			return true;
		}
		return false;
	}
	static listJurisdiction(user: User, permission: GlobalPermission | RoomPermission) {
		const symbols = Object.keys(Config.groups) as GroupSymbol[];
		return symbols.filter(targetSymbol => Auth.hasPermission(user, permission, targetSymbol));
	}
	static isValidSymbol(symbol: string): symbol is GroupSymbol {
		if (symbol.length !== 1) return false;
		return !/[A-Za-z0-9|,]/.test(symbol);
	}
}

export class RoomAuth extends Auth {
	room: BasicRoom;
	constructor(room: BasicRoom) {
		super();
		this.room = room;
	}
	get(user: ID | User): GroupSymbol {
		const parentAuth: Auth | null = this.room.parent ? this.room.parent.auth :
			this.room.settings.isPrivate !== true ? Users.globalAuth : null;
		const parentGroup = parentAuth ? parentAuth.get(user) : Auth.defaultSymbol();
		const id = typeof user === 'string' ? user : (user as User).id;

		if (this.has(id)) {
			// authority is whichever is higher between roomauth and global auth
			const roomGroup = this.getDirect(id);
			let group = Config.greatergroupscache[`${roomGroup}${parentGroup}`];
			if (!group) {
				// unrecognized groups always trump higher global rank
				const roomRank = Auth.getGroup(roomGroup, {rank: Infinity}).rank;
				const globalRank = Auth.getGroup(parentGroup).rank;
				if (roomGroup === Users.PLAYER_SYMBOL || roomGroup === Users.HOST_SYMBOL || roomGroup === '#') {
					// Player, Host, and Room Owner always trump higher global rank
					group = roomGroup;
				} else {
					group = (roomRank > globalRank ? roomGroup : parentGroup);
				}
				Config.greatergroupscache[`${roomGroup}${parentGroup}`] = group;
			}
			return group;
		}

		return parentGroup;
	}
	getEffectiveSymbol(user: User) {
		const symbol = super.getEffectiveSymbol(user);
		if (!this.room.persist && symbol === user.group) {
			const replaceGroup = Auth.getGroup(symbol).globalGroupInPersonalRoom;
			if (replaceGroup) return replaceGroup;
		}
		return symbol;
	}
	/** gets the room group without inheriting */
	getDirect(id: ID): GroupSymbol {
		return super.get(id);
	}
	save() {
		// construct auth object
		const auth = Object.create(null);
		for (const [userid, groupSymbol] of this) {
			auth[userid] = groupSymbol;
		}
		(this.room.settings as any).auth = auth;
		this.room.saveSettings();
	}
	load() {
		for (const userid in this.room.settings.auth) {
			super.set(userid as ID, this.room.settings.auth[userid]);
		}
	}
	set(id: ID, symbol: GroupSymbol) {
		const user = Users.get(id);
		if (user) {
			this.room.onUpdateIdentity(user);
		}
		if (symbol === 'whitelist' as GroupSymbol) {
			symbol = Auth.defaultSymbol();
		}
		super.set(id, symbol);
		this.room.settings.auth[id] = symbol;
		this.room.saveSettings();
		return this;
	}
	delete(id: ID) {
		if (!this.has(id)) return false;
		super.delete(id);
		delete this.room.settings.auth[id];
		this.room.saveSettings();
		return true;
	}
}

export class GlobalAuth extends Auth {
	usernames = new Map<ID, string>();
	constructor() {
		super();
		this.load();
	}
	save() {
		FS('config/usergroups.csv').writeUpdate(() => {
			let buffer = '';
			for (const [userid, groupSymbol] of this) {
				buffer += `${this.usernames.get(userid) || userid},${groupSymbol}\n`;
			}
			return buffer;
		});
	}
	load() {
		const data = FS('config/usergroups.csv').readIfExistsSync();
		for (const row of data.split("\n")) {
			if (!row) continue;
			const [name, symbol] = row.split(",");
			const id = toID(name);
			this.usernames.set(id, name);
			super.set(id, symbol.charAt(0) as GroupSymbol);
		}
	}
	set(id: ID, group: GroupSymbol, username?: string) {
		if (!username) username = id;
		const user = Users.get(id);
		if (user) {
			user.group = group;
			user.updateIdentity();
			username = user.name;
		}
		this.usernames.set(id, username);
		super.set(id, group);
		void this.save();
		return this;
	}
	delete(id: ID) {
		if (!super.has(id)) return false;
		super.delete(id);
		const user = Users.get(id);
		if (user) {
			user.group = ' ';
		}
		this.usernames.delete(id);
		this.save();
		return true;
	}
}
