// The SDK supplies the session. This reads its stable identifier for comparison,
// while authorization still uses the SDK-provided access token.
export function jwtSessionId(token: string): string | undefined {
    try {
        const payload = token.split('.')[1];
        if (!payload || !/^[A-Za-z0-9_-]+$/.test(payload) || payload.length % 4 === 1) return;
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
        let encoded = '';
        let bits = 0;
        let buffer = 0;
        for (const character of payload) {
            buffer = (buffer << 6) | alphabet.indexOf(character);
            bits += 6;
            if (bits >= 8) {
                bits -= 8;
                encoded += '%' + ((buffer >> bits) & 255).toString(16).padStart(2, '0');
            }
        }
        const claims: unknown = JSON.parse(decodeURIComponent(encoded));
        if (claims && typeof claims === 'object' && 'session_id' in claims
            && typeof claims.session_id === 'string' && claims.session_id) return claims.session_id;
    } catch {
        // Without a session ID, callers can only compare the exact token in memory.
    }
}
