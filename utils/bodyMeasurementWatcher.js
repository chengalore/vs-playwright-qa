export function startBodyMeasurementWatcher(page) {
  let status = null;

  page.on("response", (response) => {
    if (response.url().includes("/user-body-measurements")) {
      status = response.status();
      console.log("Body Measurement API Status:", status);
    }
  });

  return {
    getStatus: () => status,
  };
}
