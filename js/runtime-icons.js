function attrsToString(attrs = {}) {
    return Object.entries(attrs)
        .map(([key, value]) => `${key}="${String(value)}"`)
        .join(' ');
}

function renderSvg(base, size, attrs = {}) {
    const extra = attrsToString(attrs);
    return base.replace(
        '<svg ',
        `<svg width="${size}" height="${size}"${extra ? ` ${extra}` : ''} `
    );
}

const ATMOS_BASE =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 280 194"><path d="m 279.08361,193.27627 h -28.13515 c -53.82377,0 -96.63813,-44.03764 -96.63813,-96.638137 C 154.31033,44.037629 198.34795,0 250.94846,0 h 28.13515 z" style="fill:currentColor;stroke:none"/><path d="m 0,0 h 28.135154 c 53.82378,0 96.638146,44.037629 96.638146,96.638133 0,52.600497 -44.037631,96.638137 -96.638146,96.638137 H 0 Z" style="fill:currentColor;stroke:none"/></svg>';

const CHEVRON_RIGHT_BASE =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';

export function SVG_ATMOS(size, attrs = {}) {
    return renderSvg(ATMOS_BASE, size, attrs);
}

export function SVG_RIGHT_ARROW(size, attrs = {}) {
    return renderSvg(CHEVRON_RIGHT_BASE, size, attrs);
}
