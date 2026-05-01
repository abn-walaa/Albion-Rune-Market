const MAX_URL_LENGTH = 3800;

export function buildBatches(itemIds, baseUrl, locations, qualities) {
    const batches = [];
    let current = [];

    for (const id of itemIds) {
        current.push(id);

        const testUrl =
            `${baseUrl}/${current.join(',')}.json` +
            `?locations=${locations.join(',')}` +
            `&qualities=${qualities.join(',')}`;

        if (testUrl.length > MAX_URL_LENGTH) {
            current.pop();
            batches.push([...current]);
            current = [id];
        }
    }

    if (current.length) {
        batches.push(current);
    }

    return batches;
}
