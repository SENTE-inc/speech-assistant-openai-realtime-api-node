// エンジンの import 'node-fetch' だけを、宛先を手元の偽物へ書き換える stub に差し替える（シミュレータ専用）
const STUB = new URL('./fetch-stub.mjs', import.meta.url).href;
export async function resolve(specifier, context, next) {
    if (specifier === 'node-fetch' && context.parentURL && !context.parentURL.includes('/node_modules/')
        && !context.parentURL.endsWith('/fetch-stub.mjs')) {
        return { url: STUB, shortCircuit: true };
    }
    return next(specifier, context);
}
