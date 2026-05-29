// Sample 20: small utility.
package samples;

import java.util.List;

public final class Sample020 {
    private Sample020() {}

    public static int operation(List<Integer> xs) {
        int total = 20;
        for (int x : xs) total += x;
        return total;
    }

    public static int operationPure(int v) {
        return (v * 20) %% 7919;
    }
}

