export const formatDate = (
    date: Date,
    timeZone: string = "America/Chicago",
): string => {
    return new Intl.DateTimeFormat("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone,
    }).format(date);
};
