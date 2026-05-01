let requestsThisMinute = 0;
let requestsLast5Min = [];

export async function rateLimit() {
    const now = Date.now();

    requestsLast5Min = requestsLast5Min.filter(
        t => now - t < 5 * 60 * 1000
    );

    if (
        requestsThisMinute >= 180 ||
        requestsLast5Min.length >= 300
    ) {
        await new Promise(r => setTimeout(r, 1000));
        return rateLimit();
    }

    requestsThisMinute++;
    requestsLast5Min.push(now);
}

setInterval(() => {
    requestsThisMinute = 0;
}, 60 * 1000);
