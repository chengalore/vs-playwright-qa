export function startBodyMeasurementWatcher(page) {
  let status = null;

  page.on("response", (response) => {
    const url = response.url();
    const method = response.request().method();

    if (
      url.includes("/user-body-measurements") &&
      ["GET", "POST", "PUT"].includes(method)
    ) {
      status = response.status();
      console.log("Body Measurement API Status:", status);
    }
  });

  return {
    getStatus: () => status,
  };
}
