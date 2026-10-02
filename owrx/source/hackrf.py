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

    def getTunerFrequencyProperties(self):
        return super().getTunerFrequencyProperties() + ["ppm"]

    def getTunerFrequency(self):
        # SoapyHackRF does not implement frequency correction, so apply it here: with a reference clock running
        # ppm parts-per-million fast, programming f / (1 + ppm / 1e6) makes the hardware tune to f.
        freq = super().getTunerFrequency()
        ppm = self.sdrProps["ppm"] if "ppm" in self.sdrProps else None
        if ppm:
            freq = round(freq / (1 + ppm / 1e6))
        return freq

    def getCommandValues(self):
        values = super().getCommandValues()
        # already applied to tuner_freq; the connector must not try to apply it again.
        values.pop("ppm", None)
        return values


class HackrfDeviceDescription(SoapyConnectorDeviceDescription):
    def getName(self):
        return "HackRF"

    def supportsPpm(self):
        # not implemented by the SoapySDR module, so HackrfSource applies it to the tuned frequency itself.
        # see discussion here: https://groups.io/g/openwebrx/topic/78339109
        return True

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
