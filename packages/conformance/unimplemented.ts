// The stand-in for an export no child has implemented yet. Named imports resolve, and classes can be extended at
// module load, so test files load and each test fails on first use with the owner's name.
export function unimplemented(name: string, owner: string): any {
	const fail = () => {
		throw new Error(`conformance adapter: ${name} is not implemented yet; ${owner} owns it`);
	};
	const stub = function () {
		fail();
	};
	const member = new Map<PropertyKey, unknown>();
	return new Proxy(stub, {
		apply: fail,
		construct: fail,
		get(target, key) {
			if (key === "prototype") return target.prototype;
			if (key === "then" || typeof key === "symbol") return undefined;
			if (!member.has(key)) member.set(key, unimplemented(`${name}.${String(key)}`, owner));
			return member.get(key);
		},
	});
}
