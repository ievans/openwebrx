from owrx.source.soapy import SoapyConnectorSource, SoapyConnectorDeviceDescription
from owrx.form.input import Input
from owrx.form.input.device import BiasTeeInput
from owrx.form.input.validator import Range
from typing import List


class HackrfSource(SoapyConnectorSource):
    def getSoapySettingsMappings(self):
        mappings = super().getSoapySettingsMappings()
        mappings.update({"bias_tee": "bias_tx"})
        return mappings

    def getDriver(self):
        return "hackrf"

    # the SoapySDR module does not implement frequency correction (see https://groups.io/g/openwebrx/topic/78339109),
    # so the ppm correction is applied here by adjusting the frequency the hardware is tuned to.
    def correctFrequency(self, freq):
        ppm = self.sdrProps["ppm"] if "ppm" in self.sdrProps else None
        if not ppm:
            return freq
        return int(round(freq / (1 + ppm / 1e6)))

    def getTunerFrequency(self):
        return self.correctFrequency(super().getTunerFrequency())

    def getCommandValues(self):
        values = super().getCommandValues()
        values["tuner_freq"] = self.correctFrequency(values["tuner_freq"])
        values.pop("ppm", None)
        return values

    def onPropertyChange(self, changes):
        if self.monitor is not None and any(k in changes for k in ["center_freq", "lfo_offset", "ppm"]):
            changes.pop("ppm", None)
            changes.pop("lfo_offset", None)
            changes["center_freq"] = self.getTunerFrequency()
        super().onPropertyChange(changes)


class HackrfDeviceDescription(SoapyConnectorDeviceDescription):
    def getName(self):
        return "HackRF"

    def getInputs(self) -> List[Input]:
        return super().getInputs() + [BiasTeeInput()]

    def getDeviceOptionalKeys(self):
        return super().getDeviceOptionalKeys() + ["bias_tee"]

    def getProfileOptionalKeys(self):
        return super().getProfileOptionalKeys() + ["bias_tee"]

    def getGainStages(self):
        return ["LNA", "AMP", "VGA"]

    def getSampleRateRanges(self) -> List[Range]:
        return [Range(500000, 28000000)]
