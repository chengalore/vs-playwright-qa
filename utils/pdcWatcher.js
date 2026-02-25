export function startPDCWatcher(page) {
  const pdcData = {
    store: "unknown",
    productType: "unknown",
    gender: "unknown",
    noVisor: false,
  };

  page.on("response", async (response) => {
    if (response.url().includes("product/check")) {
      const json = await response.json().catch(() => null);

      if (json?.data) {
        pdcData.store = json.data.storeName || "unknown";
        pdcData.productType = json.data.productTypeName || "unknown";
        pdcData.gender =
          json.productData?.storeProductMeta?.gender || "unknown";
        pdcData.noVisor =
          json.data.noVisor ||
          json.productData?.storeProductMeta?.noVisor ||
          false;
      }
    }
  });

  return pdcData;
}
