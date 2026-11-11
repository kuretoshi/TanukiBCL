// Independent byte layouts for the release's managed role-reader oracles.
const pointer = (b, at, value, ps) => (ps === 8 ? b.writeBigUInt64LE(BigInt(value), at) : b.writeUInt32LE(value, at));
const region = (address, bytes) => ({ address, bytes: bytes.toString('base64') });
function edit(c, address, update) {
	const r = c.regions.find((r) => r.address === address),
		b = Buffer.from(r.bytes, 'base64');
	update(b);
	r.bytes = b.toString('base64');
	return c;
}
function snr(ps) {
	const layout = {
		pid: 42,
		pointerSize: ps,
		arraySlot: 0x10000,
		arrayType: 0x80000,
		playerType: 0x80008,
		arrayLengthOffset: ps,
		arrayDataOffset: ps * 2,
		fields: {
			playerId: { offset: 16, size: 1, signed: false, names: null },
			role: { offset: 20, size: 4, signed: true, names: { 1: 'Busker', 2: 'Jackal', 3: 'Crewmate' } },
			modifier: { offset: 24, size: 4, signed: false, names: { 0: 'None', 1: 'JumboModifier', 2: 'OtherModifier' } },
			ghostRole: { offset: 28, size: 4, signed: true, names: { 0: 'None', 1: 'Ghost' } },
		},
		jumbo: {
			abilityType: 0x82000,
			dataType: 0x82010,
			listType: 0x81000,
			itemsType: 0x81008,
			abilitiesOffset: 32,
			itemsOffset: 16,
			countOffset: 24,
			currentOffset: 24,
			dataOffset: 16,
			maxOffset: 16,
		},
		busker: {
			abilityType: 0x82008,
			listType: 0x81000,
			itemsType: 0x81008,
			abilitiesOffset: 32,
			itemsOffset: 16,
			countOffset: 24,
			activeOffset: 16,
		},
		meeting: {
			enabledSlot: 0x13000,
			pageSlot: 0x13004,
			areasSlot: 0x13008,
			listType: 0x83010,
			itemsType: 0x83018,
			voteAreaType: 0x83000,
			nativeClass: 0x83008,
			itemsOffset: 16,
			countOffset: 24,
			versionOffset: 28,
			pooledPtrOffset: 16,
			playerIdOffset: 16,
		},
	};
	const c = { mode: 'snr', pid: 42, layout, regions: [] },
		slot = Buffer.alloc(ps),
		array = Buffer.alloc(ps * 2 + 256 * ps);
	pointer(slot, 0, 0x20000, ps);
	pointer(array, 0, layout.arrayType, ps);
	array.writeUInt32LE(256, ps);
	c.regions.push(region(0x10000, slot));
	for (const [index, id] of [1, 2, 10].entries()) {
		const player = 0x30000 + id * 0x100,
			list = 0x50000 + id * 0x100,
			items = 0x60000 + id * 0x100,
			ability = 0x70000 + id * 0x100,
			data = 0x74000 + id * 0x100;
		pointer(array, ps * 2 + id * ps, player, ps);
		const b = Buffer.alloc(48);
		pointer(b, 0, layout.playerType, ps);
		b[16] = id;
		b.writeInt32LE(index + 1, 20);
		b.writeUInt32LE(index === 0 ? 3 : index === 1 ? 1 : 0, 24);
		b.writeInt32LE(1, 28);
		pointer(b, 32, list, ps);
		c.regions.push(region(player, b));
		const l = Buffer.alloc(32),
			a = Buffer.alloc(ps * 4);
		pointer(l, 0, layout.jumbo.listType, ps);
		pointer(l, 16, items, ps);
		l.writeUInt32LE(2, 24);
		pointer(a, 0, layout.jumbo.itemsType, ps);
		a.writeUInt32LE(2, ps);
		pointer(a, ps * 2, ability, ps);
		pointer(a, ps * 3, ability + 0x80, ps);
		c.regions.push(region(list, l), region(items, a));
		const jumbo = Buffer.alloc(32),
			busker = Buffer.alloc(24),
			maximum = Buffer.alloc(24);
		pointer(jumbo, 0, layout.jumbo.abilityType, ps);
		pointer(jumbo, 16, data, ps);
		jumbo.writeFloatLE(1.25, 24);
		pointer(maximum, 0, layout.jumbo.dataType, ps);
		maximum.writeFloatLE(3, 16);
		pointer(busker, 0, layout.busker.abilityType, ps);
		busker[16] = 1;
		c.regions.push(region(ability, jumbo), region(ability + 0x80, busker), region(data, maximum));
	}
	c.regions.push(region(0x20000, array));
	const enabled = Buffer.alloc(1, 1),
		page = Buffer.alloc(4),
		areas = Buffer.alloc(ps),
		list = Buffer.alloc(32),
		items = Buffer.alloc(ps * 5);
	page.writeInt32LE(1);
	pointer(areas, 0, 0x90000, ps);
	pointer(list, 0, layout.meeting.listType, ps);
	pointer(list, 16, 0x91000, ps);
	list.writeUInt32LE(3, 24);
	list.writeUInt32LE(7, 28);
	pointer(items, 0, layout.meeting.itemsType, ps);
	items.writeUInt32LE(3, ps);
	for (const [i, id] of [2, 1, 10].entries()) {
		const wrapper = Buffer.alloc(16 + ps),
			native = Buffer.alloc(17),
			address = 0x92000 + i * 0x100,
			target = 0x94000 + i * 0x100;
		pointer(items, ps * 2 + i * ps, address, ps);
		pointer(wrapper, 0, layout.meeting.voteAreaType, ps);
		pointer(wrapper, 16, target, ps);
		pointer(native, 0, layout.meeting.nativeClass, ps);
		native[16] = id;
		c.regions.push(region(address, wrapper), region(target, native));
	}
	c.regions.push(
		region(0x13000, enabled),
		region(0x13004, page),
		region(0x13008, areas),
		region(0x90000, list),
		region(0x91000, items)
	);
	return c;
}
function toh(ps) {
	const layout = {
		pid: 42,
		pointerSize: ps,
		dictionarySlot: 0x10000,
		dictionaryType: 0x60000,
		entriesType: 0x60008,
		playerType: 0x60010,
		entriesOffset: 16,
		countOffset: 24,
		versionOffset: 28,
		dataOffset: ps * 2,
		stride: ps === 8 ? 24 : 16,
		nextOffset: 4,
		keyOffset: 8,
		valueOffset: ps === 8 ? 16 : 12,
		idOffset: 16,
		roleOffset: 20,
		opportunistCanKillSlot: 0x12000,
		names: { 1: 'Opportunist', 2: 'Jackal', 3: 'Crewmate', 4: 'NotAssigned' },
		roleCatalog: ['Opportunist', 'Jackal', 'Crewmate', 'NotAssigned'].map((roleName, index) => ({
			roleId: index + 1,
			roleName,
			displayName: 'Generated ' + roleName,
			customRoleType: index < 2 ? 'Neutral' : 'Crewmate',
			isKiller: null,
		})),
		killerLayout: {
			dictionarySlot: 0x11000,
			dictionaryType: 0x60100,
			entriesType: 0x60108,
			entriesOffset: 16,
			countOffset: 24,
			versionOffset: 28,
			dataOffset: ps * 2,
			stride: ps === 8 ? 24 : 16,
			nextOffset: 4,
			keyOffset: 8,
			valueOffset: ps === 8 ? 16 : 12,
			types: { 458752: { isKiller: true, stateOffset: 16 } },
		},
	};
	const c = { mode: 'toh', pid: 42, layout, regions: [region(0x12000, Buffer.from([1]))] };
	for (const [base, meta] of [
		[0, layout],
		[0x1000, layout.killerLayout],
	]) {
		const slot = Buffer.alloc(ps),
			dictionary = Buffer.alloc(32),
			entries = Buffer.alloc(ps * 2 + 3 * meta.stride);
		pointer(slot, 0, 0x20000 + base, ps);
		pointer(dictionary, 0, meta.dictionaryType, ps);
		pointer(dictionary, 16, 0x30000 + base, ps);
		dictionary.writeInt32LE(3, 24);
		dictionary.writeInt32LE(1, 28);
		pointer(entries, 0, meta.entriesType, ps);
		entries.writeInt32LE(3, ps);
		for (let i = 0; i < 3; i++) {
			const start = ps * 2 + i * meta.stride,
				id = i + 1;
			entries.writeInt32LE(-1, start + 4);
			entries[start + 8] = id;
			pointer(entries, start + meta.valueOffset, (base ? 0x50000 : 0x40000) + id * 0x100, ps);
		}
		c.regions.push(
			region(meta.dictionarySlot, slot),
			region(0x20000 + base, dictionary),
			region(0x30000 + base, entries)
		);
	}
	for (let id = 1; id <= 3; id++) {
		const player = Buffer.alloc(24),
			role = Buffer.alloc(16 + ps);
		pointer(player, 0, layout.playerType, ps);
		player[16] = id;
		player.writeInt32LE(id, 20);
		pointer(role, 0, id === 2 ? 0x70008 : 0x70000, ps);
		pointer(role, 16, 0x40000 + (id === 3 ? 2 : id) * 0x100, ps);
		c.regions.push(region(0x40000 + id * 0x100, player), region(0x50000 + id * 0x100, role));
	}
	return c;
}
export function modFixtures() {
	const cases = [];
	for (const ps of [4, 8]) {
		cases.push(snr(ps));
		for (const role of [-1, 0, 99]) cases.push(edit(snr(ps), 0x30100, (b) => b.writeInt32LE(role, 20)));
		for (const modifier of [0, 1, 2, 4, 0x80000000])
			cases.push(edit(snr(ps), 0x30100, (b) => b.writeUInt32LE(modifier, 24)));
		for (const size of [0, 0.1, -1, NaN, Infinity]) cases.push(edit(snr(ps), 0x70100, (b) => b.writeFloatLE(size, 24)));
		for (const size of [0, 0.1, -1, NaN]) cases.push(edit(snr(ps), 0x74100, (b) => b.writeFloatLE(size, 16)));
		for (const active of [0, 2, 255]) cases.push(edit(snr(ps), 0x70180, (b) => (b[16] = active)));
		cases.push(edit(snr(ps), 0x30100, (b) => (b[16] = 7)));
		cases.push({ ...snr(ps), mutateAddress: 0x30100, afterReads: 2 });
		for (const update of [
			(c) => c.layout.pid++,
			(c) => c.layout.arraySlot++,
			(c) => (c.layout.arrayDataOffset = 3),
			(c) => (c.layout.fields.role.size = 3),
			(c) => (c.layout.fields.role.offset = 0),
			(c) => c.layout.jumbo.abilityType++,
			(c) => (c.layout.busker.activeOffset = -1),
			(c) => (c.layout.fields.role.names = { 1: 7 }),
		]) {
			const c = snr(ps);
			update(c);
			cases.push(c);
		}
		const normal = snr(ps);
		normal.mode = 'meeting';
		cases.push(normal);
		for (const enabled of [0, 2]) {
			const c = snr(ps);
			c.mode = 'meeting';
			cases.push(edit(c, 0x13000, (b) => (b[0] = enabled)));
		}
		for (const page of [0, -1, 2]) {
			const c = snr(ps);
			c.mode = 'meeting';
			cases.push(edit(c, 0x13004, (b) => b.writeInt32LE(page)));
		}
		for (const id of [2, 255]) {
			const c = snr(ps);
			c.mode = 'meeting';
			cases.push(edit(c, 0x94100, (b) => (b[16] = id)));
		}
		cases.push(toh(ps));
		for (const enabled of [0, 2]) cases.push(edit(toh(ps), 0x12000, (b) => (b[0] = enabled)));
		for (const role of [0, 4, 99]) cases.push(edit(toh(ps), 0x40100, (b) => b.writeInt32LE(role, 20)));
		cases.push(edit(toh(ps), 0x40100, (b) => (b[16] = 9)));
		cases.push({ ...toh(ps), mutateAddress: 0x40114, afterReads: 2 });
		for (const update of [
			(c) => c.layout.pid++,
			(c) => c.layout.dictionaryType++,
			(c) => (c.layout.stride = 4),
			(c) => c.layout.dataOffset++,
			(c) => (c.layout.roleCatalog[0].customRoleType = 'unknown'),
			(c) => (c.layout.roleCatalog[0].roleName = 'Wrong'),
			(c) => c.layout.roleCatalog.push(c.layout.roleCatalog[0]),
			(c) => (c.layout.killerLayout.types[458752].isKiller = 1),
			(c) => (c.layout.killerLayout = null),
			(c) => (c.layout.opportunistCanKillSlot = 0),
		]) {
			const c = toh(ps);
			update(c);
			cases.push(c);
		}
	}
	return cases;
}
